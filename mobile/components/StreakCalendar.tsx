import { View, Text, StyleSheet } from 'react-native';

import type { CalendarDay } from '../lib/api';
import { colors, radius, spacing, streakLevels, type as t } from '../lib/theme';

/**
 * Streak calendar, matching the web app's .cal-0 … .cal-4 ramp.
 *
 * A longer run gives a deeper, bolder day; a short one a light, thin day; a
 * rest day stays empty. Depth AND border weight both carry the intensity, so
 * the scale survives a colour-vision deficiency rather than relying on hue.
 *
 * The buckets come from the server, computed from the quantiles of this user's
 * own history — fixed thresholds would put every day in one bucket for
 * somebody whose normal run is 2 km, and equally for somebody running 20 km.
 */

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

type Props = {
  days: CalendarDay[];
  streak: { current: number; longest: number; longestThisMonth: number };
};

export default function StreakCalendar({ days, streak }: Props) {
  if (!days.length) return <Text style={s.muted}>No data for this month.</Text>;

  // Monday-first leading blanks, so the 1st lands under the right weekday.
  const lead = days[0].weekday;
  const cells: Array<CalendarDay | null> = [
    ...Array(lead).fill(null),
    ...days,
  ];

  return (
    <View style={s.wrap}>
      <View style={s.row}>
        {DOW.map((d, i) => (
          <View key={i} style={s.cell}>
            <Text style={s.dow}>{d}</Text>
          </View>
        ))}
      </View>

      <View style={s.grid}>
        {cells.map((day, i) => {
          if (!day) return <View key={`blank-${i}`} style={s.cell} />;

          const level = streakLevels[Math.min(day.intensity, 4)];

          return (
            <View key={day.date} style={s.cell}>
              <View
                style={[
                  s.day,
                  {
                    backgroundColor: level.bg,
                    borderColor: level.border,
                    borderWidth: level.width,
                  },
                  day.isFuture && s.future,
                  day.isToday && s.today,
                ]}
                // Screen readers get the real numbers, so intensity never has
                // to be inferred from the shade.
                accessible
                accessibilityLabel={
                  day.runs > 0
                    ? `${day.date}: ${day.distanceKm.toFixed(2)} kilometres over ` +
                      `${day.runs} ${day.runs === 1 ? 'run' : 'runs'}`
                    : `${day.date}: rest day`
                }
              >
                <Text
                  style={[
                    s.dayText,
                    { color: level.text },
                    day.intensity >= 3 && s.dayTextStrong,
                  ]}
                >
                  {day.day}
                </Text>
              </View>
            </View>
          );
        })}
      </View>

      <View style={s.footer}>
        <Mini label="Current" value={`${streak.current}d`} />
        <Mini label="This month" value={`${streak.longestThisMonth}d`} />
        <Mini label="Best ever" value={`${streak.longest}d`} />
      </View>

      <View style={s.legend}>
        <Text style={s.legendText}>Less</Text>
        {streakLevels.map((l, i) => (
          <View
            key={i}
            style={[s.swatch, {
              backgroundColor: l.bg, borderColor: l.border, borderWidth: l.width,
            }]}
          />
        ))}
        <Text style={s.legendText}>More</Text>
      </View>
    </View>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.mini}>
      <Text style={s.miniLabel}>{label}</Text>
      <Text style={s.miniValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: spacing.sm },
  row: { flexDirection: 'row' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },

  // Seven per row: 100/7 leaves a rounding gap, so each cell takes 14.28%.
  cell: { width: '14.28%', aspectRatio: 1, padding: 2 },

  day: { flex: 1, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  dayText: { fontSize: 11, fontWeight: '500' },
  dayTextStrong: { fontWeight: '700' },

  future: { opacity: 0.4, borderStyle: 'dashed' },
  today: { borderColor: colors.accent[500], borderWidth: 2 },

  dow: { ...t.label, fontSize: 9, color: colors.ink[400], textAlign: 'center' },

  footer: {
    flexDirection: 'row', justifyContent: 'space-around',
    borderTopWidth: 1, borderTopColor: colors.ink[100],
    paddingTop: spacing.sm,
  },
  mini: { alignItems: 'center' },
  miniLabel: { ...t.label, fontSize: 9, color: colors.ink[500] },
  miniValue: { fontSize: 14, fontWeight: '700', color: colors.ink[900], fontVariant: ['tabular-nums'] },

  legend: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3 },
  legendText: { fontSize: 9, color: colors.ink[400] },
  swatch: { width: 11, height: 11, borderRadius: 3 },

  muted: { fontSize: 12, color: colors.ink[500] },
});
