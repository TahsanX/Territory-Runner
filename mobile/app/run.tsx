import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView, Alert, AppState, Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import * as queue from '../lib/queue';
import * as track from '../lib/location-task';
import * as sync from '../lib/sync';
import { api, localDate, tzOffset } from '../lib/api';
import * as fmt from '../lib/format';
import { colors, radius, shadow, spacing, type as t } from '../lib/theme';
import RunMap from '../components/RunMap';

const GpsFilter = require('../../shared/gps-filter');

/**
 * Live run screen.
 *
 * The recording itself happens in the background task (lib/location-task.ts),
 * which writes to SQLite. This screen polls that queue for display, so the UI
 * shows exactly what has actually been recorded — including everything
 * captured while the screen was locked.
 */
export default function RunScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [sessionId, setSessionId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [pausedMs, setPausedMs] = useState(0);
  const pauseStartedAt = useRef<number | null>(null);

  const [points, setPoints] = useState<Array<[number, number]>>([]);
  const [distanceKm, setDistanceKm] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncState, setSyncState] = useState<sync.SyncState>('idle');
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.finishRun>> | null>(null);
  const [mode, setMode] = useState<track.TrackingMode>('precise');
  const [busy, setBusy] = useState(false);

  // -- Recover an interrupted run -------------------------------------------
  // The app may have been killed mid-run while the background task kept
  // recording. The active_run row is the source of truth, not component state.
  useEffect(() => {
    (async () => {
      const active = await queue.getActiveRun();
      if (!active) return;

      setSessionId(active.sessionId);
      setRunning(true);
      setPaused(active.isPaused);
      setStartedAt(new Date(active.startedAt).getTime());
      setPausedMs(active.pausedMs);
      await refreshFromQueue(active.sessionId);
      await activateKeepAwakeAsync().catch(() => {});
    })();
  }, []);

  useEffect(() => sync.onSyncChange((state, n) => {
    setSyncState(state);
    setPendingCount(n);
  }), []);

  // -- Poll the queue for display -------------------------------------------
  const refreshFromQueue = useCallback(async (id: number) => {
    const rows = await queue.track(id);
    const real = rows.filter((r) => !r.isPauseMarker);

    setPoints(real.map((r) => [r.longitude, r.latitude]));   // GeoJSON order

    let km = 0;
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i].isPauseMarker || rows[i + 1].isPauseMarker) continue;
      km += GpsFilter.haversineMetres(
        rows[i].latitude, rows[i].longitude,
        rows[i + 1].latitude, rows[i + 1].longitude
      ) / 1000;
    }
    setDistanceKm(km);
    setPendingCount(await queue.pendingCount(id));
  }, []);

  useEffect(() => {
    if (!running || !sessionId) return;
    const id = setInterval(() => {
      refreshFromQueue(sessionId).catch(() => {});
      if (!paused && startedAt) {
        const held = pausedMs + (pauseStartedAt.current ? Date.now() - pauseStartedAt.current : 0);
        setElapsed(Math.max(0, Math.floor((Date.now() - startedAt - held) / 1000)));
      }
    }, 2000);
    return () => clearInterval(id);
  }, [running, sessionId, paused, startedAt, pausedMs, refreshFromQueue]);

  // Flush opportunistically while running, and immediately on returning to
  // the foreground, where the backlog from a locked screen will be waiting.
  useEffect(() => {
    if (!running || !sessionId) return;

    const timer = setInterval(() => { sync.flush(sessionId).catch(() => {}); }, 20000);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        sync.flush(sessionId).catch(() => {});
        refreshFromQueue(sessionId).catch(() => {});
      }
    });

    return () => { clearInterval(timer); subscription.remove(); };
  }, [running, sessionId, refreshFromQueue]);

  // -- Permissions -----------------------------------------------------------
  async function ensurePermissions(): Promise<boolean> {
    let state = await track.getPermissions();

    if (!state.foreground) {
      state = await track.requestForeground();
      if (!state.foreground) {
        Alert.alert(
          'Location needed',
          'Territory Runner traces your route from your location. Without it there is nothing to record.',
          [{ text: 'Not now' }, { text: 'Open settings', onPress: () => Linking.openSettings() }]
        );
        return false;
      }
    }

    if (!state.background) {
      // Explain BEFORE asking. Requesting "always allow" cold is the single
      // biggest cause of outright denial.
      return new Promise((resolve) => {
        Alert.alert(
          'Keep recording with the screen locked',
          'Grant "Allow all the time" so your route keeps recording when you pocket your phone. ' +
          'Without it, recording stops the moment the screen locks — exactly the problem the ' +
          'web version has.',
          [
            {
              text: 'Record only while open',
              onPress: () => resolve(true),      // degrade, don't block
              style: 'cancel',
            },
            {
              text: 'Continue',
              onPress: async () => {
                const next = await track.requestBackground();
                if (!next.background) {
                  Alert.alert(
                    'Background location not granted',
                    'Your run will record only while the app is open and the screen is on. ' +
                    'You can change this later in Settings.'
                  );
                }
                resolve(true);
              },
            },
          ]
        );
      });
    }

    return true;
  }

  // -- Controls --------------------------------------------------------------
  async function start() {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await ensurePermissions())) return;

      const { sessionId: id } = await api.startRun();
      await queue.startRun(id, localDate(), tzOffset());
      await track.startTracking(mode);
      await activateKeepAwakeAsync().catch(() => {});

      setSessionId(id);
      setRunning(true);
      setPaused(false);
      setStartedAt(Date.now());
      setPausedMs(0);
      setPoints([]);
      setDistanceKm(0);
      setElapsed(0);
      setResult(null);
    } catch (err: any) {
      Alert.alert(
        'Could not start',
        err?.offline
          ? 'You need a connection to start a run. Once it is running, you can go offline safely.'
          : err?.message ?? 'Unknown error'
      );
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (!sessionId) return;

    if (paused) {
      const held = pausedMs + (pauseStartedAt.current ? Date.now() - pauseStartedAt.current : 0);
      pauseStartedAt.current = null;
      setPausedMs(held);
      setPaused(false);
      await queue.setPaused(false, held);
    } else {
      pauseStartedAt.current = Date.now();
      setPaused(true);
      await queue.setPaused(true, pausedMs);

      // A real pause marker row, so moving time excludes the gap.
      const rows = await queue.track(sessionId);
      const last = rows.filter((r) => !r.isPauseMarker).pop();
      if (last) {
        const seq = await queue.reserveSeq(1);
        await queue.enqueue([{
          sessionId, seq,
          latitude: last.latitude, longitude: last.longitude,
          accuracy: null, isPauseMarker: true,
          recordedAt: new Date().toISOString(),
        }]);
      }
      sync.flush(sessionId).catch(() => {});
    }
  }

  async function finish() {
    if (!sessionId || busy) return;

    if (points.length < 3) {
      Alert.alert('Not enough recorded', 'Keep running a little longer before finishing.');
      return;
    }

    setBusy(true);
    try {
      await track.stopTracking();
      deactivateKeepAwake().catch(() => {});

      const outcome = await sync.finishRun(sessionId);

      if (outcome.ok) {
        setRunning(false);
        setPaused(false);
        setResult(outcome.result);
        return;
      }

      // Keep the run alive rather than losing it. The queue is durable and
      // will finish the moment there is a connection.
      if (outcome.reason === 'offline') {
        Alert.alert(
          'Saved on your phone',
          `${outcome.pending} recorded points are waiting to upload. Your run and any ` +
          'territory will be claimed automatically as soon as you are back online.',
          [{ text: 'OK', onPress: () => router.replace('/') }]
        );
      } else {
        Alert.alert('Could not finish', outcome.message ?? 'Try again in a moment.');
        await track.startTracking(mode);   // resume; the run is not over
      }
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    Alert.alert(
      'Discard this run?',
      'The route recorded so far will be deleted and no territory claimed.',
      [
        { text: 'Keep running', style: 'cancel' },
        {
          text: 'Discard', style: 'destructive',
          onPress: async () => {
            await track.stopTracking();
            deactivateKeepAwake().catch(() => {});
            if (sessionId) await queue.clearSession(sessionId);
            await queue.clearActiveRun();
            router.replace('/');
          },
        },
      ]
    );
  }

  // -- Render ----------------------------------------------------------------
  const syncLabel =
    syncState === 'offline' ? `Offline · ${pendingCount} queued`
    : syncState === 'syncing' ? 'Syncing…'
    : syncState === 'error' ? `Retrying · ${pendingCount} queued`
    : pendingCount > 0 ? `${pendingCount} queued`
    : running ? 'Synced' : '';

  const syncColor =
    syncState === 'offline' || syncState === 'error' ? colors.warning
    : pendingCount > 0 ? colors.accent[600]
    : colors.success;

  if (result) {
    return (
      <ScrollView contentContainerStyle={[s.resultWrap, { paddingBottom: insets.bottom + 24 }]}>
        <View style={s.card}>
          {result.territoryCreated ? (
            <>
              <Text style={[s.resultKicker, { color: colors.own }]}>Territory captured</Text>
              <Text style={s.resultBig}>{fmt.area(result.territoryArea)}</Text>
              {result.areaStolen > 0 && (
                <Text style={s.resultNote}>
                  Took {fmt.area(result.areaStolen)} from {result.territoriesAffected}
                  {result.territoriesAffected === 1 ? ' rival territory' : ' rival territories'}
                </Text>
              )}
            </>
          ) : (
            <>
              <Text style={s.resultKicker}>Run saved</Text>
              <Text style={s.resultNote}>
                {result.isClosedLoop
                  ? 'The loop closed but the enclosed area was too small to claim.'
                  : 'Finish within 50 m of where you started to close the loop and claim it.'}
              </Text>
            </>
          )}

          <View style={s.resultGrid}>
            <Stat label="Distance" value={fmt.distance(result.stats.distance)} />
            <Stat label="Time" value={fmt.duration(result.stats.time)} />
            <Stat label="Pace" value={fmt.pace(result.stats.distance, result.stats.time)} />
            <Stat label="Calories" value={fmt.number(result.stats.calories)} />
          </View>

          <Pressable style={[s.btn, s.btnPrimary]} onPress={() => router.replace('/')}>
            <Text style={s.btnPrimaryText}>Back to dashboard</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={s.screen}>
      <RunMap route={points} />

      <View style={[s.panel, { paddingBottom: insets.bottom + spacing.md }]}>
        <View style={s.panelHead}>
          <View style={[s.badge, {
            backgroundColor: !running ? colors.ink[100] : paused ? '#b4530920' : '#0d948820',
          }]}>
            <Text style={[s.badgeText, {
              color: !running ? colors.ink[600] : paused ? colors.rival : colors.own,
            }]}>
              {!running ? 'Ready' : paused ? 'Paused' : 'Recording'}
            </Text>
          </View>

          {!!syncLabel && <Text style={[s.sync, { color: syncColor }]}>{syncLabel}</Text>}
        </View>

        <View style={s.metrics}>
          <Metric label="Distance" value={distanceKm.toFixed(2)} unit="km" />
          <Metric label="Time" value={fmt.duration(elapsed)} />
          <Metric label="Pace" value={fmt.pace(distanceKm, elapsed)} small />
          <Metric label="Points" value={String(points.length)} small />
        </View>

        {!running ? (
          <>
            <Pressable
              style={[s.btn, s.btnPrimary, busy && s.btnDisabled]}
              onPress={start} disabled={busy}
            >
              <Text style={s.btnPrimaryText}>{busy ? 'Starting…' : 'Start run'}</Text>
            </Pressable>

            <Pressable
              style={s.modeRow}
              onPress={() => setMode(mode === 'precise' ? 'balanced' : 'precise')}
            >
              <Text style={s.modeText}>
                {mode === 'precise' ? 'Best accuracy' : 'Battery saver'}
              </Text>
              <Text style={s.modeHint}>
                {mode === 'precise'
                  ? 'Tightest route, heavier battery use'
                  : 'Looser route, much lighter on battery'}
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={s.btnRow}>
              <Pressable
                style={[s.btn, s.btnFlex, paused ? s.btnPrimary : s.btnWarning]}
                onPress={togglePause}
              >
                <Text style={paused ? s.btnPrimaryText : s.btnWarningText}>
                  {paused ? 'Resume' : 'Pause'}
                </Text>
              </Pressable>
              <Pressable
                style={[s.btn, s.btnFlex, s.btnDanger, busy && s.btnDisabled]}
                onPress={finish} disabled={busy}
              >
                <Text style={s.btnDangerText}>{busy ? 'Saving…' : 'Finish'}</Text>
              </Pressable>
            </View>

            <Pressable onPress={discard} style={s.discard}>
              <Text style={s.discardText}>Discard run</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

function Metric({ label, value, unit, small }: {
  label: string; value: string; unit?: string; small?: boolean;
}) {
  return (
    <View style={s.metric}>
      <Text style={s.metricLabel}>{label}</Text>
      <Text style={small ? s.metricValueSmall : s.metricValue}>
        {value}{unit ? <Text style={s.metricUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.statCell}>
      <Text style={s.metricLabel}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink[50] },

  panel: {
    backgroundColor: colors.white,
    borderTopWidth: 1, borderTopColor: colors.ink[200],
    paddingHorizontal: spacing.lg, paddingTop: spacing.md,
    gap: spacing.md,
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '600' },
  sync: { fontSize: 12, fontWeight: '500' },

  metrics: { flexDirection: 'row', justifyContent: 'space-between' },
  metric: { flex: 1 },
  metricLabel: { ...t.label, color: colors.ink[500], marginBottom: 2 },
  metricValue: { ...t.stat, color: colors.ink[900], fontVariant: ['tabular-nums'] },
  metricValueSmall: { fontSize: 17, fontWeight: '600', color: colors.ink[800], fontVariant: ['tabular-nums'] },
  metricUnit: { fontSize: 13, fontWeight: '500', color: colors.ink[500] },

  btn: {
    borderRadius: radius.DEFAULT, paddingVertical: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  btnFlex: { flex: 1 },
  btnRow: { flexDirection: 'row', gap: spacing.sm },
  btnPrimary: { backgroundColor: colors.accent[600] },
  btnPrimaryText: { color: colors.white, fontSize: 15, fontWeight: '600' },
  btnWarning: { backgroundColor: colors.warning },
  btnWarningText: { color: colors.white, fontSize: 15, fontWeight: '600' },
  btnDanger: { backgroundColor: colors.danger },
  btnDangerText: { color: colors.white, fontSize: 15, fontWeight: '600' },
  btnDisabled: { opacity: 0.55 },

  modeRow: { alignItems: 'center', gap: 1 },
  modeText: { fontSize: 13, fontWeight: '600', color: colors.accent[700] },
  modeHint: { fontSize: 11, color: colors.ink[400] },

  discard: { alignItems: 'center', paddingVertical: 4 },
  discardText: { fontSize: 13, color: colors.ink[400] },

  resultWrap: { padding: spacing.lg },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.ink[200],
    padding: spacing.lg, gap: spacing.sm, ...shadow.card,
  },
  resultKicker: { fontSize: 13, fontWeight: '700', color: colors.ink[700] },
  resultBig: { ...t.statLg, color: colors.ink[900] },
  resultNote: { fontSize: 13, color: colors.ink[600], lineHeight: 19 },
  resultGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    marginTop: spacing.sm, marginBottom: spacing.sm,
  },
  statCell: { width: '50%', marginBottom: spacing.md },
  statValue: { fontSize: 17, fontWeight: '600', color: colors.ink[900], fontVariant: ['tabular-nums'] },
});
