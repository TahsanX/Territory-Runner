import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';

/**
 * Supabase Auth on mobile.
 *
 * This is where the Phase 1 decision to use Supabase Auth pays off twice:
 * there is no custom mobile token flow to write, and token refresh and secure
 * persistence come with the client.
 */

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string>;

export const SUPABASE_URL = extra.supabaseUrl || '';
export const SUPABASE_ANON_KEY = extra.supabaseAnonKey || '';
export const ENABLE_GOOGLE_OAUTH = extra.enableGoogleOauth === 'true';

/**
 * Sessions go in the Keychain / Android Keystore, never AsyncStorage.
 *
 * AsyncStorage is plaintext on disk; an auth token sitting there is readable on
 * a rooted or jailbroken device, and by anything with filesystem access.
 *
 * SecureStore has a 2048-byte limit per value, and a Supabase session with a
 * large JWT can approach it, so oversized values are chunked.
 */
const CHUNK = 1800;

const secureAdapter = {
  getItem: async (key: string): Promise<string | null> => {
    try {
      const head = await SecureStore.getItemAsync(key);
      if (head === null) return null;
      if (!head.startsWith('__chunks__:')) return head;

      const count = Number(head.split(':')[1]);
      let out = '';
      for (let i = 0; i < count; i++) {
        const part = await SecureStore.getItemAsync(`${key}.${i}`);
        if (part === null) return null;   // incomplete write; treat as absent
        out += part;
      }
      return out;
    } catch {
      return null;
    }
  },

  setItem: async (key: string, value: string): Promise<void> => {
    try {
      if (value.length <= CHUNK) {
        await SecureStore.setItemAsync(key, value);
        return;
      }
      const count = Math.ceil(value.length / CHUNK);
      for (let i = 0; i < count; i++) {
        await SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
      }
      await SecureStore.setItemAsync(key, `__chunks__:${count}`);
    } catch (err) {
      console.warn('[auth] could not persist session:', (err as Error).message);
    }
  },

  removeItem: async (key: string): Promise<void> => {
    try {
      const head = await SecureStore.getItemAsync(key);
      if (head?.startsWith('__chunks__:')) {
        const count = Number(head.split(':')[1]);
        for (let i = 0; i < count; i++) {
          await SecureStore.deleteItemAsync(`${key}.${i}`);
        }
      }
      await SecureStore.deleteItemAsync(key);
    } catch { /* already gone */ }
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: secureAdapter,
    storageKey: 'tr-session',
    persistSession: true,
    autoRefreshToken: true,
    // Mobile completes OAuth through an explicit AuthSession exchange below,
    // not by the client parsing a browser URL.
    detectSessionInUrl: false,
  },
});

/** The current access token, refreshed if it has expired. */
export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

/**
 * Google sign-in via the system browser.
 *
 * `openAuthSessionAsync` uses ASWebAuthenticationSession on iOS and a Custom
 * Tab on Android — both of which share the system cookie jar, so someone
 * already signed in to Google is not asked to type a password again. An
 * embedded WebView would neither share that state nor be accepted by Google.
 *
 * The redirect URI must be registered in Supabase under
 * Authentication -> URL Configuration.
 */
export async function signInWithGoogle(): Promise<void> {
  if (!ENABLE_GOOGLE_OAUTH) {
    throw new Error('Google sign-in is not enabled. Use email and password.');
  }

  const redirectTo = AuthSession.makeRedirectUri({ scheme: 'territoryrunner', path: 'auth' });

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw new Error(error.message);
  if (!data?.url) throw new Error('Could not start Google sign-in.');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    throw new Error('Sign-in cancelled.');
  }
  if (result.type !== 'success' || !result.url) {
    throw new Error('Sign-in did not complete.');
  }

  await completeSessionFromUrl(result.url);
}

/** Exchange whatever the redirect carried for a session. */
async function completeSessionFromUrl(url: string): Promise<void> {
  const parsed = new URL(url);

  // PKCE flow: a code in the query string.
  const code = parsed.searchParams.get('code');
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw new Error(error.message);
    return;
  }

  // Implicit flow: tokens in the fragment.
  const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
  const access_token = fragment.get('access_token');
  const refresh_token = fragment.get('refresh_token');

  if (access_token && refresh_token) {
    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) throw new Error(error.message);
    return;
  }

  const description =
    parsed.searchParams.get('error_description') || fragment.get('error_description');
  throw new Error(description || 'Sign-in did not return a session.');
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signUp(
  email: string,
  password: string,
  username: string
): Promise<{ confirmed: boolean }> {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    // Read by the on_auth_user_created trigger to name the profile row.
    options: { data: { username } },
  });
  if (error) throw new Error(error.message);
  return { confirmed: Boolean(data.session) };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
