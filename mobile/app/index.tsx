import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, RefreshControl, Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';

import { api, type Profile, type CalendarDay } from '../lib/api';
import * as queue from '../lib/queue';
import * as sync from '../lib/sync';
import { signOut } from '../lib/supabase';
import * as fmt from '../lib/format';
import { colors, radius, shadow, spacing, type as t } from '../lib/theme';
import StreakCalendar from '../components/StreakCalendar';

export default function Dashboard() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [calendar, setCalendar] = useState<{
    days: CalendarDay[];
    streak: { current: number; longest: number; longestThisMonth: number };
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resumable, setResumable] = useState<number | null>(null);
  const [backlog, setBacklog] = useState(0);

  const load = useCallback(async () => {
    const now = new Date();

    // Parallel, so one slow query does not hold up the whole screen.
    const [p, h, c] = await Promise.allSettled([
      api.profile(),
      api.history(8),
      api.calendar(now.getFullYear(), now.getMonth() + 1),
    ]);

    if (p.status === 'fulfilled') setProfile(p.value);
    if (h.status === 'fulfilled') setHistory(h.value.sessions);
    if (c.status === 'fulfilled') setCalendar({ days: c.value.days, streak: c.value.streak });
  }, []);

  // Checked on every focus, not just on mount: the app may have been killed
  // while the background task kept recording, so there can be a run to resume
  // or a backlog to upload that this screen knows nothing about yet.
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    (async () => {
      const active = await queue.getActiveRun();
      if (!cancelled) setResumable(active?.sessionId ?? null);

      const sessions = await queue.sessionsWithBacklog();
      if (!cancelled) setBacklog(sessions.length);

      load().catch(() => {});
    })();
    return () => { cancelled = true; };
  }, [load]));

  async function onRefresh() {
    setRefreshing(true);
    await sync.flushAll().catch(() => {});
    await load().catch(() => {});
    const sessions = await queue.sessionsWithBacklog();
    setBacklog(sessions.length);
    setRefreshing(false);
  }

  function confirmSignOut() {
    Alert.alert('Sign out?', 'Any run still waiting to upload will stay on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
    ]);
  }

  const stats = profile?.stats;

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent[500]} />
      }
    >
      {/* A run recovered from a previous session takes priority over
          everything else on screen — it is unfinished business. */}
      {resumable !== null && (
        <Pressable style={[s.card, s.resumeCard]} onPress={() => router.push('/run')}>
          <Text style={s.resumeTitle}>Run in progress</Text>
          <Text style={s.resumeText}>
            A run is still recording from an earlier session. Tap to resume and finish it.
          </Text>
        </Pressable>
      )}

      {backlog > 0 && resumable === null && (
        <View style={[s.card, s.backlogCard]}>
          <Text style={s.backlogTitle}>Waiting to upload</Text>
          <Text style={s.backlogText}>
            {backlog === 1 ? 'A run' : `${backlog} runs`} recorded offline will sync
            automatically. Pull down to retry now.
          </Text>
        </View>
      )}

      <View style={s.card}>
        <Text style={s.greeting}>
          {profile ? `Hello, ${profile.user.username}` : 'Territory Runner'}
        </Text>
        <Text style={s.sub}>
          Close a loop to claim the ground inside it. Run over someone else's
          territory and the overlap becomes yours.
        </Text>
        <Pressable style={[s.btn, s.btnPrimary]} onPress={() => router.push('/run')}>
          <Text style={s.btnPrimaryText}>
            {resumable !== null ? 'Resume run' : 'Start a run'}
          </Text>
        </Pressable>
      </View>

      <Text style={s.sectionTitle}>Lifetime</Text>
      <View style={s.statGrid}>
        <StatTile label="Distance" value={stats ? stats.totalDistance.toFixed(1) : '—'} unit="km" />
        <StatTile label="Territory" value={stats ? fmt.area(stats.totalTerritoryArea) : '—'} />
        <StatTile label="Calories" value={stats ? fmt.number(stats.totalCalories) : '—'} />
        <StatTile label="Runs" value={stats ? fmt.number(stats.totalRunningSessions) : '—'} />
      </View>

      {profile?.ranks && (
        <Pressable style={s.rankRow} onPress={() => router.push('/leaderboard')}>
          <Text style={s.rankText}>
            Territory {profile.ranks.area ? fmt.ordinal(profile.ranks.area.rank) : '—'}
            {'   ·   '}
            Distance {profile.ranks.distance ? fmt.ordinal(profile.ranks.distance.rank) : '—'}
          </Text>
          <Text style={s.rankLink}>Leaderboard</Text>
        </Pressable>
      )}

      <Text style={s.sectionTitle}>Streak</Text>
      <View style={s.card}>
        {calendar ? (
          <StreakCalendar days={calendar.days} streak={calendar.streak} />
        ) : (
          <Text style={s.muted}>Loading…</Text>
        )}
      </View>

      <Text style={s.sectionTitle}>Recent runs</Text>
      <View style={s.card}>
        {history.length === 0 ? (
          <Text style={s.muted}>
            No runs yet. Complete a loop back to where you began to claim your
            first territory.
          </Text>
        ) : (
          history.map((run, i) => (
            <View key={run.id} style={[s.historyRow, i > 0 && s.historyDivider]}>
              <View style={{ flex: 1 }}>
                <Text style={s.historyPrimary}>
                  {fmt.distance(run.totalDistance)} · {fmt.duration(run.totalTime)}
                </Text>
                <Text style={s.historySecondary}>
                  {fmt.dateTime(run.endTime || run.createdAt)}
                  {run.placeLocality ? ` · ${run.placeLocality}` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                {run.territoryId ? (
                  <Text style={s.gained}>+{fmt.area(run.territoryArea)}</Text>
                ) : (
                  <Text style={s.muted}>No capture</Text>
                )}
                <Text style={s.historySecondary}>
                  {fmt.pace(run.totalDistance, run.totalTime)}
                </Text>
              </View>
            </View>
          ))
        )}
      </View>

      <View style={s.navRow}>
        <Pressable style={[s.btn, s.btnSecondary, s.btnFlex]} onPress={() => router.push('/summary')}>
          <Text style={s.btnSecondaryText}>Summary</Text>
        </Pressable>
        <Pressable style={[s.btn, s.btnSecondary, s.btnFlex]} onPress={() => router.push('/leaderboard')}>
          <Text style={s.btnSecondaryText}>Leaderboard</Text>
        </Pressable>
      </View>

      <Pressable onPress={confirmSignOut} style={s.signOut}>
        <Text style={s.signOutText}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

function StatTile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={s.statTile}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue}>
        {value}{unit ? <Text style={s.statUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink[50] },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },

  card: {
    backgroundColor: colors.white, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.ink[200],
    padding: spacing.lg, gap: spacing.sm, ...shadow.card,
  },

  resumeCard: { borderColor: colors.accent[300], backgroundColor: colors.accent[50] },
  resumeTitle: { fontSize: 15, fontWeight: '700', color: colors.accent[800] },
  resumeText: { fontSize: 13, color: colors.accent[700], lineHeight: 18 },

  backlogCard: { borderColor: '#b4530940', backgroundColor: '#b4530912' },
  backlogTitle: { fontSize: 14, fontWeight: '700', color: colors.warning },
  backlogText: { fontSize: 12, color: colors.ink[600], lineHeight: 17 },

  greeting: { ...t.title, color: colors.ink[900] },
  sub: { fontSize: 13, color: colors.ink[500], lineHeight: 19 },

  sectionTitle: { ...t.label, color: colors.ink[500], marginTop: spacing.sm },

  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  statTile: {
    flexGrow: 1, flexBasis: '46%',
    backgroundColor: colors.white, borderRadius: radius.DEFAULT,
    borderWidth: 1, borderColor: colors.ink[200], padding: spacing.md,
  },
  statLabel: { ...t.label, color: colors.ink[500], marginBottom: 2 },
  statValue: { fontSize: 22, fontWeight: '700', color: colors.ink[900], fontVariant: ['tabular-nums'] },
  statUnit: { fontSize: 13, fontWeight: '500', color: colors.ink[500] },

  rankRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
  },
  rankText: { fontSize: 12, color: colors.ink[600] },
  rankLink: { fontSize: 12, fontWeight: '600', color: colors.accent[600] },

  historyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, gap: spacing.sm },
  historyDivider: { borderTopWidth: 1, borderTopColor: colors.ink[100] },
  historyPrimary: { fontSize: 14, fontWeight: '600', color: colors.ink[800] },
  historySecondary: { fontSize: 11, color: colors.ink[500], marginTop: 1 },
  gained: { fontSize: 12, fontWeight: '700', color: colors.own },
  muted: { fontSize: 12, color: colors.ink[500], lineHeight: 18 },

  btn: { borderRadius: radius.DEFAULT, paddingVertical: 13, alignItems: 'center' },
  btnFlex: { flex: 1 },
  btnPrimary: { backgroundColor: colors.accent[600], marginTop: spacing.xs },
  btnPrimaryText: { color: colors.white, fontSize: 15, fontWeight: '600' },
  btnSecondary: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.ink[300] },
  btnSecondaryText: { color: colors.ink[700], fontSize: 14, fontWeight: '600' },

  navRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },

  signOut: { alignItems: 'center', paddingVertical: spacing.md },
  signOutText: { fontSize: 13, color: colors.ink[400] },
});
