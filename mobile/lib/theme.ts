/**
 * Design tokens, mirroring tailwind.config.js exactly.
 *
 * Kept as plain constants rather than pulling in NativeWind, so there is one
 * obvious place where web and mobile can be compared. If a value changes in
 * tailwind.config.js it must change here too — that duplication is deliberate
 * and small, and it is what stops the two clients drifting apart visually.
 */

export const colors = {
  ink: {
    50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1',
    400: '#94a3b8', 500: '#64748b', 600: '#475569', 700: '#334155',
    800: '#1e293b', 900: '#0f172a',
  },
  accent: {
    50: '#eef6ff', 100: '#d9eaff', 200: '#bcdaff', 300: '#8ec2ff',
    400: '#599fff', 500: '#2f7df5', 600: '#1b60d6', 700: '#174dad',
    800: '#18428a', 900: '#183a72',
  },
  own: '#0d9488',
  ownSoft: '#5eead4',
  rival: '#b45309',
  rivalSoft: '#fcd34d',
  success: '#15803d',
  warning: '#b45309',
  danger: '#b91c1c',
  white: '#ffffff',
} as const;

export const radius = { sm: 6, DEFAULT: 8, lg: 10, xl: 14, pill: 999 } as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

export const type = {
  stat: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.5 },
  statLg: { fontSize: 36, fontWeight: '700' as const, letterSpacing: -0.8 },
  title: { fontSize: 20, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  small: { fontSize: 13, fontWeight: '400' as const },
  label: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.6, textTransform: 'uppercase' as const },
} as const;

export const shadow = {
  card: {
    shadowColor: '#0f172a',
    shadowOpacity: 0.06,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
} as const;

/** The same five-step calendar ramp as the web app's .cal-0 … .cal-4. */
export const streakLevels = [
  { bg: colors.ink[50],  border: colors.ink[200], width: 1,   text: colors.ink[400] },
  { bg: '#0d94881a',     border: '#0d94884d',     width: 1,   text: colors.own },
  { bg: '#0d948840',     border: '#0d948873',     width: 1.5, text: colors.own },
  { bg: '#0d948873',     border: '#0d9488a6',     width: 2,   text: colors.white },
  { bg: colors.own,      border: colors.own,      width: 2,   text: colors.white },
] as const;

/** Territory fill, matching public/js/map-config.js territoryStyle(). */
export const territoryFill = {
  own:   { line: colors.own,   fill: colors.ownSoft,   fillOpacity: 0.3,  lineWidth: 2 },
  rival: { line: colors.rival, fill: colors.rivalSoft, fillOpacity: 0.18, lineWidth: 1.5 },
} as const;
