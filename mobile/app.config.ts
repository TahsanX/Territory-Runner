import type { ExpoConfig } from 'expo/config';

/**
 * Expo configuration.
 *
 * The background-location permissions below are the whole reason this app
 * exists: a browser suspends geolocation the moment the screen locks, so the
 * web app loses the rest of the route whenever a runner pockets their phone.
 *
 * Only EXPO_PUBLIC_* values are safe here — everything in `extra` ends up
 * readable inside the app bundle. The Supabase anon key belongs here (it is
 * constrained by the RLS policies in config/schema.sql); the service-role key
 * never does, because it bypasses every one of them.
 */
const config: ExpoConfig = {
  name: 'Territory Runner',
  slug: 'territory-running-app',
  version: '1.0.0',
  orientation: 'portrait',
  scheme: 'territoryrunner',          // the OAuth redirect target
  userInterfaceStyle: 'light',
  newArchEnabled: false,

  icon: './assets/icon.png',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#f8fafc',
  },

  assetBundlePatterns: ['**/*'],

  ios: {
    supportsTablet: false,
    bundleIdentifier: 'com.territoryrunner.app',
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      // Without this, iOS kills location updates on backgrounding.
      UIBackgroundModes: ['location', 'fetch'],

      // App Review rejects vague background-location justifications, so these
      // strings state plainly what is collected and why.
      NSLocationWhenInUseUsageDescription:
        'Territory Runner uses your location to trace your running route and work out the area you capture.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Territory Runner needs location access while in the background so your route keeps recording when your screen is locked or you switch apps. Without it, part of every run is lost.',
      NSLocationAlwaysUsageDescription:
        'Territory Runner records your route in the background so a locked screen does not interrupt your run.',
    },
  },

  android: {
    package: 'com.territoryrunner.app',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#2f7df5',
    },
    permissions: [
      'ACCESS_COARSE_LOCATION',
      'ACCESS_FINE_LOCATION',
      // Android 10+ requires this separately from foreground location.
      'ACCESS_BACKGROUND_LOCATION',
      // Android 14 requires the typed foreground-service permission.
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_LOCATION',
      'WAKE_LOCK',
      'POST_NOTIFICATIONS',
    ],
  },

  plugins: [
    'expo-router',
    '@maplibre/maplibre-react-native',
    'expo-secure-store',
    [
      'expo-location',
      {
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true,
        locationAlwaysAndWhenInUsePermission:
          'Territory Runner needs background location so your route keeps recording with the screen locked.',
      },
    ],
    [
      'expo-notifications',
      { icon: './assets/notification-icon.png', color: '#2f7df5' },
    ],
    [
      'expo-splash-screen',
      { backgroundColor: '#f8fafc', image: './assets/splash.png', imageWidth: 180 },
    ],
  ],

  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000',
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
    maptilerKey: process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '',
    // Off unless explicitly enabled. Google sign-in needs an OAuth client in
    // the Google Cloud console and the provider switched on in Supabase; until
    // both exist, the button is hidden rather than shipped broken. Kept as a
    // string so `extra` stays all-strings for the typed read in lib/supabase.ts.
    enableGoogleOauth: process.env.EXPO_PUBLIC_ENABLE_GOOGLE_OAUTH ?? 'false',
    eas: { projectId: process.env.EAS_PROJECT_ID ?? 'c11faa54-fc1b-40d6-b761-f0fb24766680' },
  },

  experiments: { typedRoutes: true },
};

export default config;
