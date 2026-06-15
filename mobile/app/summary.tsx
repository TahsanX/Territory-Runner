import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, RefreshControl,
} from 'react-native';

import { api } from '../lib/api';
import * as fmt from '../lib/format';
import { colors, radius, shadow, spacing, type as t } from '../lib/theme';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Monthly and yearly summary — the same endpoint the web app uses, so the two
 * clients can never disagree about a total.
 */
export default function Summary() {
  const now = new Date();
  const [period, setPeriod] = useState<'month' | 'year'>('month');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await api.summary(period, year, month));
    } catch (err: any) {
      setError(err?.message ?? 'Could not load the summary.');
    }
  }, [period, year, month]);

  useEffect(() => { load(); }, [load]);

  function shift(delta: number) {
    if (period === 'year') { setYear(year + delta); return; }
    let m = month + delta;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
  }

  const totals = data?.totals;
  const battles = data?.territoryBattles;

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} tintColor={colors.accent[500]}
          onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />
      }
    >
      <View style={s.tabs}>
        {(['month', 'year'] as const).map((p) => (
          <Pressable
            key={p}
            style={[s.tab, period === p && s.tabActive]}
            onPress={() => setPeriod(p)}
          >
            <Text style={[s.tabText, period === p && s.tabTextActive]}>
              {p === 'month' ? 'Month' : 'Year'}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={s.periodRow}>
        <Pressable style={s.navBtn} onPress={() => shift(-1)} accessibilityLabel="Previous period">
          <Text style={s.navBtnText}>‹</Text>
        </Pressable>
        <Text style={s.periodLabel}>
          {period === 'year' ? String(year) : `${MONTHS[month - 1]} ${year}`}
        </Text>
        <Pressable style={s.navBtn} onPress={() => shift(1)} accessibilityLabel="Next period">
          <Text style={s.navBtnText}>›</Text>
        </Pressable>
      </View>

      {!!error && <Text style={s.error}>{error}</Text>}

      {totals && (
        <>
          <View style={s.grid}>
            <Tile label="Distance" value={fmt.distance(totals.distanceKm)}
                  note={`${totals.runs} ${totals.runs === 1 ? 'run' : 'runs'}`} />
            <Tile label="Calories" value={fmt.number(totals.calories)} note="burned" />
            <Tile label="Active days" value={String(totals.activeDays)} note="with a run" />
            <Tile label="Time" value={fmt.duration(totals.movingSeconds)} note="moving" />
          </View>

          {/* Territory gained against lost — the chart that makes the
              stealing mechanic legible at a glance. */}
          <Text style={s.sectionTitle}>Territory</Text>
          <View style={s.card}>
            <Bar label="Captured" value={totals.areaGainedM2}
                 max={Math.max(totals.areaGainedM2, totals.areaLostM2, 1)} color={colors.own} />
            <Bar label="Lost to rivals" value={totals.areaLostM2}
                 max={Math.max(totals.areaGainedM2, totals.areaLostM2, 1)} color={colors.rival} />
            <View style={s.netRow}>
              <Text style={s.netLabel}>Net</Text>
              <Text style={[s.netValue, {
                color: totals.netAreaM2 >= 0 ? colors.success : colors.danger,
              }]}>
                {totals.netAreaM2 >= 0 ? '+' : '−'}{fmt.area(Math.abs(totals.netAreaM2))}
              </Text>
            </View>
          </View>

          <Text style={s.sectionTitle}>Streak</Text>
          <View style={[s.card, s.streakRow]}>
            <Mini label={`In this ${period}`} value={`${data.streak.longestInPeriod}d`} highlight />
            <Mini label="Current" value={`${data.streak.current}d`} />
            <Mini label="All time" value={`${data.streak.longestAllTime}d`} />
          </View>

          {battles && (
            <>
              <Text style={s.sectionTitle}>Territory battles</Text>
              <View style={s.grid}>
                <Tile label="Taken" value={String(battles.won.events)}
                      note={`${fmt.area(battles.won.areaM2)} gained`} tone="up" />
                <Tile label="Lost" value={String(battles.lost.events)}
                      note={`${battles.lost.rivals} ${battles.lost.rivals === 1 ? 'rival' : 'rivals'}`}
                      tone="down" />
              </View>
            </>
          )}

          {data.ranks && (
            <>
              <Text style={s.sectionTitle}>Leaderboard position</Text>
              <View style={s.grid}>
                <Tile label="Territory"
                      value={data.ranks.area ? fmt.ordinal(data.ranks.area.rank) : '—'}
                      note={data.ranks.area ? `of ${data.ranks.area.total}` : undefined} />
                <Tile label="Distance"
                      value={data.ranks.distance ? fmt.ordinal(data.ranks.distance.rank) : '—'}
                      note={data.ranks.distance ? `of ${data.ranks.distance.total}` : undefined} />
              </View>
            </>
          )}

          <Text style={s.sectionTitle}>Places you ran most</Text>
          <View style={s.card}>
            {data.places?.length ? data.places.map((p: any, i: number) => (
              <View key={p.locality} style={[s.placeRow, i > 0 && s.divider]}>
                <Text style={s.placeRank}>{i + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.placeName} numberOfLines={1}>{p.locality}</Text>
                  <View style={s.placeTrack}>
                    <View style={[s.placeFill, {
                      width: `${(p.visits / data.places[0].visits) * 100}%`,
                    }]} />
                  </View>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={s.placeVisits}>{p.visits}</Text>
                  <Text style={s.placeDist}>{fmt.distance(p.distanceKm)}</Text>
                </View>
              </View>
            )) : (
              <Text style={s.muted}>
                Place names are looked up when a run finishes. They will appear
                here after your next few runs.
              </Text>
            )}
          </View>

          {data.bestRun && (
            <>
              <Text style={s.sectionTitle}>Best single run</Text>
              <View style={s.card}>
                <Text style={s.bestValue}>{fmt.distance(data.bestRun.distanceKm)}</Text>
                <Text style={s.muted}>
                  {fmt.duration(data.bestRun.timeSeconds)} ·{' '}
                  {fmt.pace(data.bestRun.distanceKm, data.bestRun.timeSeconds)}
                  {data.bestRun.locality ? ` · ${data.bestRun.locality}` : ''}
                </Text>
                <Text style={s.bestDate}>{fmt.date(data.bestRun.date)}</Text>
              </View>
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Tile({ label, value, note, tone }: {
  label: string; value: string; note?: string; tone?: 'up' | 'down';
}) {
  const color = tone === 'up' ? colors.success : tone === 'down' ? colors.danger : colors.ink[900];
  return (
    <View style={s.tile}>
      <Text style={s.tileLabel}>{label}</Text>
      <Text style={[s.tileValue, { color }]}>{value}</Text>
      {!!note && <Text style={s.tileNote}>{note}</Text>}
    </View>
  );
}

function Bar({ label, value, max, color }: {
  label: string; value: number; max: number; color: string;
}) {
  return (
    <View style={s.barWrap}>
      <View style={s.barHead}>
        <Text style={[s.barLabel, { color }]}>{label}</Text>
        <Text style={s.barValue}>{fmt.area(value)}</Text>
      </View>
      <View style={s.barTrack}>
        <View style={[s.barFill, { width: `${(value / max) * 100}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

function Mini({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={s.tileLabel}>{label}</Text>
      <Text style={[s.miniValue, highlight && { color: colors.own }]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink[50] },
  content: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },

  tabs: { flexDirection: 'row', gap: spacing.xs },
  tab: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.accent[600] },
  tabText: { fontSize: 14, fontWeight: '500', color: colors.ink[500] },
  tabTextActive: { color: colors.accent[700], fontWeight: '600' },

  periodRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  periodLabel: { ...t.title, fontSize: 17, color: colors.ink[900] },
  navBtn: {
    width: 34, height: 34, borderRadius: radius.DEFAULT,
    borderWidth: 1, borderColor: colors.ink[300], backgroundColor: colors.white,
    alignItems: 'center', justifyContent: 'center',
  },
  navBtnText: { fontSize: 20, color: colors.ink[600], lineHeight: 22 },

  sectionTitle: { ...t.label, color: colors.ink[500], marginTop: spacing.md },

  card: {
    backgroundColor: colors.white, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.ink[200],
    padding: spacing.lg, gap: spacing.sm, ...shadow.card,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexGrow: 1, flexBasis: '46%',
    backgroundColor: colors.white, borderRadius: radius.DEFAULT,
    borderWidth: 1, borderColor: colors.ink[200], padding: spacing.md,
  },
  tileLabel: { ...t.label, color: colors.ink[500], marginBottom: 2 },
  tileValue: { fontSize: 21, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tileNote: { fontSize: 11, color: colors.ink[500], marginTop: 1 },

  barWrap: { gap: 4 },
  barHead: { flexDirection: 'row', justifyContent: 'space-between' },
  barLabel: { fontSize: 12, fontWeight: '600' },
  barValue: { fontSize: 12, color: colors.ink[700], fontVariant: ['tabular-nums'] },
  barTrack: { height: 9, borderRadius: radius.pill, backgroundColor: colors.ink[100], overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: radius.pill },

  netRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderTopWidth: 1, borderTopColor: colors.ink[100], paddingTop: spacing.sm,
  },
  netLabel: { fontSize: 13, color: colors.ink[500] },
  netValue: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },

  streakRow: { flexDirection: 'row' },
  miniValue: { fontSize: 22, fontWeight: '700', color: colors.ink[900], fontVariant: ['tabular-nums'] },

  placeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  divider: { borderTopWidth: 1, borderTopColor: colors.ink[100] },
  placeRank: { width: 18, fontSize: 11, fontWeight: '700', color: colors.ink[400], textAlign: 'center' },
  placeName: { fontSize: 14, fontWeight: '500', color: colors.ink[800] },
  placeTrack: { height: 5, borderRadius: radius.pill, backgroundColor: colors.ink[100], marginTop: 5, overflow: 'hidden' },
  placeFill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.accent[500] },
  placeVisits: { fontSize: 13, fontWeight: '600', color: colors.ink[700], fontVariant: ['tabular-nums'] },
  placeDist: { fontSize: 10, color: colors.ink[400] },

  bestValue: { ...t.stat, color: colors.ink[900] },
  bestDate: { fontSize: 11, color: colors.ink[400] },

  muted: { fontSize: 12, color: colors.ink[500], lineHeight: 18 },
  error: { fontSize: 13, color: colors.danger, paddingVertical: spacing.sm },
});
