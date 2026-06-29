import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import * as queue from './queue';
// The EXACT filter the web app uses. Native "BestForNavigation" accuracy is
// not the same thing as accurate — it still emits urban-canyon spikes — and if
// the two platforms filtered differently they would disagree about the same
// run's distance.
const GpsFilter = require('../../shared/gps-filter');

export const LOCATION_TASK = 'territory-runner-location';

/**
 * Background location task.
 *
 * This is the decisive advantage over the web app, which stops recording the
 * instant the screen locks or the tab is hidden — meaning a runner who pockets
 * their phone loses the rest of the route and the territory with it.
 *
 * The task runs in a separate JavaScript context from the UI. It therefore
 * cannot share React state or module-level variables with the app, which is
 * why everything it needs is read from and written to SQLite. It must also do
 * as little as possible and never throw: an unhandled error here gets the task
 * killed by the OS mid-run.
 */

// Per-context filter. The task context is recreated by the OS from time to
// time, so this is rebuilt lazily and reset when the session changes.
let filter: any = null;
let filterSessionId: number | null = null;

function filterFor(sessionId: number) {
  if (!filter || filterSessionId !== sessionId) {
    filter = new GpsFilter();
    filterSessionId = sessionId;
  }
  return filter;
}

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
  if (error) {
    console.warn('[location-task]', error.message);
    return;
  }
  if (!data?.locations?.length) return;

  try {
    const run = await queue.getActiveRun();
    // No active run, or paused: discard rather than recording a stale track.
    if (!run || run.isPaused) return;

    const f = filterFor(run.sessionId);
    const accepted: Array<{ lat: number; lon: number; acc: number | null; at: string }> = [];

    for (const loc of data.locations as Location.LocationObject[]) {
      const result = f.accept({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        accuracy: loc.coords.accuracy,
        timestamp: loc.timestamp,
      });
      if (result.accepted) {
        accepted.push({
          lat: result.point.latitude,
          lon: result.point.longitude,
          acc: result.point.accuracy,
          at: new Date(result.point.timestamp).toISOString(),
        });
      }
    }

    if (!accepted.length) return;

    // Claim the sequence block in one go. The foreground UI can be appending
    // at the same time, so the counter has to be handed out transactionally.
    const start = await queue.reserveSeq(accepted.length);

    await queue.enqueue(
      accepted.map((p, i) => ({
        sessionId: run.sessionId,
        seq: start + i,
        latitude: p.lat,
        longitude: p.lon,
        accuracy: p.acc,
        isPauseMarker: false,
        recordedAt: p.at,
      }))
    );

    // Upload is NOT attempted here. The task has a tight execution budget and
    // may be running with no connectivity; the fixes are durable in SQLite, so
    // syncing is left to the foreground, which has the auth session and can
    // retry properly.
  } catch (err: any) {
    // Swallow deliberately: letting this throw gets the task terminated and
    // ends the run silently.
    console.warn('[location-task] failed:', err?.message);
  }
});

export type PermissionState = {
  foreground: boolean;
  background: boolean;
  canAskAgain: boolean;
};

/**
 * Request location permission in the right order.
 *
 * Asking for "always allow" cold is the most common reason people deny it
 * outright, so foreground is requested first and the caller is expected to
 * explain why background is needed before escalating.
 */
export async function requestForeground(): Promise<PermissionState> {
  const fg = await Location.requestForegroundPermissionsAsync();
  const bg = await Location.getBackgroundPermissionsAsync();
  return {
    foreground: fg.status === 'granted',
    background: bg.status === 'granted',
    canAskAgain: fg.canAskAgain,
  };
}

export async function requestBackground(): Promise<PermissionState> {
  const fg = await Location.getForegroundPermissionsAsync();
  if (fg.status !== 'granted') {
    return { foreground: false, background: false, canAskAgain: fg.canAskAgain };
  }
  const bg = await Location.requestBackgroundPermissionsAsync();
  return {
    foreground: true,
    background: bg.status === 'granted',
    canAskAgain: bg.canAskAgain,
  };
}

export async function getPermissions(): Promise<PermissionState> {
  const fg = await Location.getForegroundPermissionsAsync();
  const bg = await Location.getBackgroundPermissionsAsync();
  return {
    foreground: fg.status === 'granted',
    background: bg.status === 'granted',
    canAskAgain: fg.canAskAgain,
  };
}

export type TrackingMode = 'balanced' | 'precise';

/**
 * Begin background updates.
 *
 * The 'balanced' mode trades fidelity for battery on long runs. The foreground
 * service notification is mandatory on Android 8+ for background location and
 * doubles as a live run readout in the notification shade.
 */
export async function startTracking(mode: TrackingMode = 'precise'): Promise<void> {
  const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  if (already) return;

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: mode === 'precise'
      ? Location.Accuracy.BestForNavigation
      : Location.Accuracy.High,

    // Distance-based rather than purely time-based: standing still should not
    // wake the GPS, which is both wasteful and a source of drift.
    distanceInterval: mode === 'precise' ? 5 : 15,
    timeInterval: mode === 'precise' ? 2000 : 6000,

    // iOS batches updates when it can, which saves significant battery.
    deferredUpdatesInterval: mode === 'precise' ? 0 : 15000,
    deferredUpdatesDistance: mode === 'precise' ? 0 : 50,

    // iOS pauses updates automatically when it decides the user has stopped
    // moving, and does not reliably resume. For a run that silently truncates
    // the track, so it is disabled.
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Fitness,

    showsBackgroundLocationIndicator: true,

    foregroundService: {
      notificationTitle: 'Recording your run',
      notificationBody: 'Territory Runner is tracing your route.',
      notificationColor: '#2f7df5',
      killServiceOnDestroy: false,
    },
  });
}

export async function stopTracking(): Promise<void> {
  const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  if (running) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  filter = null;
  filterSessionId = null;
}

export async function isTracking(): Promise<boolean> {
  return Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
}
