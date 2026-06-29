import NetInfo from '@react-native-community/netinfo';

import * as queue from './queue';
import { api, ApiError } from './api';

/**
 * Drains the SQLite queue to the server.
 *
 * Only runs in the foreground, where there is an auth session and the time to
 * retry properly. The background location task deliberately only writes to
 * SQLite — see lib/location-task.ts.
 *
 * Correctness rule throughout: a batch is marked sent ONLY after the server
 * has acknowledged it. The (running_session_id, seq) unique constraint means a
 * batch that was actually received but whose response was lost gets absorbed
 * on retry instead of duplicating the track, so retrying is always safe and
 * dropping is never necessary.
 */

const BATCH = 100;

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

let syncing = false;
const listeners = new Set<(state: SyncState, pending: number) => void>();

export function onSyncChange(fn: (state: SyncState, pending: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(state: SyncState, pending: number) {
  listeners.forEach((fn) => {
    try { fn(state, pending); } catch { /* a listener must not break the sync */ }
  });
}

export async function isOnline(): Promise<boolean> {
  const net = await NetInfo.fetch();
  // isInternetReachable can be null while it is still being determined;
  // treat unknown as online and let the request itself decide.
  return Boolean(net.isConnected) && net.isInternetReachable !== false;
}

/**
 * Flush one session's backlog.
 * Returns the number of fixes the server accepted.
 */
export async function flush(sessionId: number): Promise<number> {
  if (syncing) return 0;
  syncing = true;

  let sent = 0;
  try {
    if (!(await isOnline())) {
      emit('offline', await queue.pendingCount(sessionId));
      return 0;
    }

    emit('syncing', await queue.pendingCount(sessionId));

    for (;;) {
      const batch = await queue.pending(sessionId, BATCH);
      if (!batch.length) break;

      try {
        await api.uploadCoordinates(
          sessionId,
          batch.map((f) => ({
            seq: f.seq,
            latitude: f.latitude,
            longitude: f.longitude,
            accuracy: f.accuracy,
            isPauseMarker: f.isPauseMarker,
            recordedAt: f.recordedAt,
          }))
        );

        await queue.markSent(batch.map((f) => f.id!).filter(Boolean));
        sent += batch.length;
      } catch (err) {
        const e = err as ApiError;

        if (e.offline) {
          // Leave everything queued; this is the dead-zone case the queue
          // exists for.
          emit('offline', await queue.pendingCount(sessionId));
          return sent;
        }

        // 409 means the run is already finished server-side, so these fixes
        // can never be accepted and retrying forever would wedge the queue.
        if (e.status === 409) {
          await queue.markSent(batch.map((f) => f.id!).filter(Boolean));
          continue;
        }

        emit('error', await queue.pendingCount(sessionId));
        return sent;
      }
    }

    emit('idle', 0);
    return sent;
  } finally {
    syncing = false;
  }
}

/**
 * Flush every session with a backlog, on app launch or on regaining
 * connectivity. This is what recovers a run recorded entirely offline, or one
 * interrupted by the app being killed.
 */
export async function flushAll(): Promise<void> {
  const sessions = await queue.sessionsWithBacklog();
  for (const id of sessions) {
    await flush(id);
  }
}

/**
 * Finish a run.
 *
 * The whole backlog must be uploaded BEFORE finishing: the server computes
 * distance, the closed-loop test and the territory steal from the coordinates
 * it holds, so finishing early would silently discard the tail of the route
 * and with it the territory.
 */
export async function finishRun(sessionId: number): Promise<
  | { ok: true; result: Awaited<ReturnType<typeof api.finishRun>> }
  | { ok: false; reason: 'offline' | 'pending' | 'error'; pending: number; message?: string }
> {
  await flush(sessionId);

  const outstanding = await queue.pendingCount(sessionId);
  if (outstanding > 0) {
    const online = await isOnline();
    return {
      ok: false,
      reason: online ? 'pending' : 'offline',
      pending: outstanding,
    };
  }

  try {
    const result = await api.finishRun(sessionId);
    await queue.clearActiveRun();
    await queue.clearSession(sessionId);
    return { ok: true, result };
  } catch (err) {
    const e = err as ApiError;
    return {
      ok: false,
      reason: e.offline ? 'offline' : 'error',
      pending: 0,
      message: e.message,
    };
  }
}

/** Start flushing automatically whenever the device comes back online. */
export function watchConnectivity(): () => void {
  return NetInfo.addEventListener((state) => {
    if (state.isConnected && state.isInternetReachable !== false) {
      flushAll().catch(() => { /* the next change event will retry */ });
    }
  });
}
