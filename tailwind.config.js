/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs', './public/js/**/*.js', './shared/**/*.js'],

  // These class names are only ever assembled at runtime — `'gps-' + quality`,
  // `'toast-' + type`, `'cal-' + intensity`, `'rank-' + position` — so the
  // scanner cannot see them in the source and strips the rules. Without this
  // the GPS pill, toasts and streak calendar all render uncoloured.
  safelist: [
    'gps-excellent', 'gps-good', 'gps-fair', 'gps-poor', 'gps-unknown',
    'toast-success', 'toast-error', 'toast-info',
    'cal-0', 'cal-1', 'cal-2', 'cal-3', 'cal-4',
    'rank-1', 'rank-2', 'rank-3', 'rank-plain',
  ],
  theme: {
    extend: {
      colors: {
        // One neutral scale and one accent, replacing the four unrelated
        // palettes the old stylesheets mixed together (Flat UI, Bootstrap
        // alert colours, stray Tailwind hexes, and Material blue).
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
        // Territory ownership. Deliberately desaturated: these sit over map
        // tiles at partial opacity, and saturated fills made the basemap
        // unreadable underneath.
        own: { DEFAULT: '#0d9488', soft: '#5eead4' },
        rival: { DEFAULT: '#b45309', soft: '#fcd34d' },
        success: '#15803d',
        warning: '#b45309',
        danger: '#b91c1c',
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        // Nested radius resolves as inner = outer - gap. A card at 0.625rem
        // with a 0.5rem gap gives its children `DEFAULT`.
        DEFAULT: '0.5rem',
        lg: '0.625rem',
        xl: '0.875rem',
      },
      transitionTimingFunction: {
        // Single base curve. Everything that moves uses it.
        base: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        raised: '0 4px 12px -2px rgb(15 23 42 / 0.10)',
        overlay: '0 12px 32px -8px rgb(15 23 42 / 0.22)',
      },
      fontSize: {
        // Named display sizes for the metric readouts. Semibold is the ceiling;
        // heavier weights make tabular figures look blocky at these sizes.
        'stat': ['1.75rem', { lineHeight: '1.1', letterSpacing: '-0.02em', fontWeight: '600' }],
        'stat-lg': ['2.25rem', { lineHeight: '1.05', letterSpacing: '-0.025em', fontWeight: '600' }],
        'stat-xl': ['3rem', { lineHeight: '1', letterSpacing: '-0.03em', fontWeight: '600' }],
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'reveal': {
          '0%': { opacity: '0', transform: 'translateY(32px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.18s cubic-bezier(0.22, 1, 0.36, 1)',
        'toast-in': 'toast-in 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
        'reveal': 'reveal 0.7s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
    },
  },
  plugins: [],
};
