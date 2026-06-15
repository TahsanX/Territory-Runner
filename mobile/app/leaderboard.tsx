import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, RefreshControl,
} from 'react-native';

import { api } from '../lib/api';
import * as fmt from '../lib/format';
import { colors, radius, spacing, type as t } from '../lib/theme';

type Row = {
  rank: number;
  username: string;
  total_territory_area: number;
  total_distance: number;
  total_running_sessions: number;
};

export default function Leaderboard() {
  const [metric, setMetric] = useState<'area' | 'distance'>('area');
  const [rows, setRows] = useState<Row[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (which: 'area' | 'distance') => {
    setError('');
    try {
      const [board, profile] = await Promise.allSettled([
        api.leaderboard(which, 50),
        api.profile(),
      ]);
      if (board.status === 'fulfilled') setRows(board.value.leaderboard);
      else setError('Could not load the leaderboard.');
      if (profile.status === 'fulfilled') setMe(profile.value.user.username);
    } catch {
      setError('Could not load the leaderboard.');
    }
  }, []);

  useEffect(() => { load(metric); }, [metric, load]);

  async function onRefresh() {
    setRefreshing(true);
    await load(metric);
    setRefreshing(false);
  }

  return (
    <View style={s.screen}>
      <View style={s.tabs}>
        {(['area', 'distance'] as const).map((m) => (
          <Pressable
            key={m}
            style={[s.tab, metric === m && s.tabActive]}
            onPress={() => setMetric(m)}
            accessibilityRole="tab"
            accessibilityState={{ selected: metric === m }}
          >
            <Text style={[s.tabText, metric === m && s.tabTextActive]}>
              {m === 'area' ? 'Territory' : 'Distance'}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => `${r.rank}-${r.username}`}
        contentContainerStyle={s.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent[500]} />
        }
        ListEmptyComponent={
          <Text style={s.empty}>
            {error || 'Nobody has claimed any ground yet. Be first.'}
          </Text>
        }
        renderItem={({ item }) => {
          const isMe = me !== null && item.username === me;
          const primary = metric === 'area'
            ? fmt.area(item.total_territory_area)
            : fmt.distance(item.total_distance);
          const secondary = metric === 'area'
            ? fmt.distance(item.total_distance)
            : fmt.area(item.total_territory_area);

          return (
            <View style={[s.row, isMe && s.rowMe]}>
              <Text style={[s.rank, item.rank <= 3 && s.rankTop]}>{item.rank}</Text>
              <View style={s.nameCol}>
                <Text style={[s.name, isMe && s.nameMe]} numberOfLines={1}>
                  {item.username}{isMe ? '  (you)' : ''}
                </Text>
                <Text style={s.meta}>
                  {secondary} · {fmt.number(item.total_running_sessions)} runs
                </Text>
              </View>
              <Text style={s.value}>{primary}</Text>
            </View>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink[50] },

  tabs: {
    flexDirection: 'row', backgroundColor: colors.white,
    borderBottomWidth: 1, borderBottomColor: colors.ink[200],
    paddingHorizontal: spacing.lg,
  },
  tab: { paddingVertical: spacing.md, paddingHorizontal: spacing.md, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.accent[600] },
  tabText: { fontSize: 14, fontWeight: '500', color: colors.ink[500] },
  tabTextActive: { color: colors.accent[700], fontWeight: '600' },

  list: { padding: spacing.lg, gap: spacing.xs },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.white, borderRadius: radius.DEFAULT,
    borderWidth: 1, borderColor: colors.ink[200],
    paddingVertical: spacing.md, paddingHorizontal: spacing.md,
  },
  rowMe: { borderColor: colors.accent[300], backgroundColor: colors.accent[50] },

  rank: {
    width: 26, fontSize: 14, fontWeight: '600',
    color: colors.ink[400], textAlign: 'center', fontVariant: ['tabular-nums'],
  },
  rankTop: { color: colors.accent[700], fontWeight: '700' },

  nameCol: { flex: 1 },
  name: { fontSize: 14, fontWeight: '600', color: colors.ink[800] },
  nameMe: { color: colors.accent[800] },
  meta: { fontSize: 11, color: colors.ink[500], marginTop: 1 },

  value: { fontSize: 14, fontWeight: '700', color: colors.ink[900], fontVariant: ['tabular-nums'] },

  empty: { fontSize: 13, color: colors.ink[500], textAlign: 'center', paddingVertical: spacing.xxl },
});
