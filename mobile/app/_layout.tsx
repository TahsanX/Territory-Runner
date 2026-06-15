import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ActivityIndicator, LogBox, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

import { supabase } from '../lib/supabase';
import { watchConnectivity, flushAll } from '../lib/sync';
import { colors } from '../lib/theme';

// Importing this registers the background task. It MUST happen at module scope
// in the root layout: the OS can relaunch the app straight into the task's
// context, and a task that is not registered by then is silently dropped.
import '../lib/location-task';

SplashScreen.preventAutoHideAsync().catch(() => { /* already hidden */ });

// MapTiler's style ships one tile-less source; MapLibre warns but renders fine.
LogBox.ignoreLogs(['source must have tiles']);

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSignedIn(Boolean(data.session));
      setReady(true);
      SplashScreen.hideAsync().catch(() => {});
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(Boolean(session));
    });

    // Flush anything recorded while offline or while the app was killed. This
    // is what recovers a run completed entirely in a dead zone.
    flushAll().catch(() => { /* connectivity watcher will retry */ });
    const unwatch = watchConnectivity();

    return () => {
      active = false;
      sub.subscription.unsubscribe();
      unwatch();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const inAuthGroup = segments[0] === 'login';

    if (!signedIn && !inAuthGroup) router.replace('/login');
    else if (signedIn && inAuthGroup) router.replace('/');
  }, [ready, signedIn, segments]);

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink[50] }}>
        <ActivityIndicator color={colors.accent[500]} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.white },
          headerTitleStyle: { fontSize: 16, fontWeight: '600', color: colors.ink[900] },
          headerTintColor: colors.accent[600],
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.ink[50] },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Territory Runner' }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        {/* Full-screen while running: the map and the metrics are the whole
            interface, and a header would just cost vertical space. */}
        <Stack.Screen name="run" options={{ title: 'Run', headerBackVisible: false }} />
        <Stack.Screen name="leaderboard" options={{ title: 'Leaderboard' }} />
        <Stack.Screen name="summary" options={{ title: 'Summary' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
