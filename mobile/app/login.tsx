import { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';

import {
  ENABLE_GOOGLE_OAUTH,
  signInWithGoogle,
  signInWithPassword,
  signUp,
} from '../lib/supabase';
import { colors, radius, shadow, spacing, type as t } from '../lib/theme';

/**
 * Sign in / sign up.
 *
 * Supabase Auth handles OAuth, password hashing, token refresh and account
 * linking by verified email, so there is no custom mobile token flow here —
 * which was a direct reason for choosing it in Phase 1.
 */
export default function Login() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  /** Supabase's messages are terse; turn them into something actionable. */
  function friendly(raw: string): string {
    const m = raw.toLowerCase();
    if (m.includes('invalid login credentials')) return 'That email and password do not match.';
    if (m.includes('email not confirmed')) return 'Confirm your email first — check your inbox.';
    if (m.includes('already registered')) return 'That email already has an account. Try signing in.';
    if (m.includes('rate limit')) return 'Too many attempts. Wait a minute and try again.';
    if (m.includes('cancelled')) return '';
    return raw;
  }

  async function google() {
    setError(''); setNotice(''); setBusy(true);
    try {
      await signInWithGoogle();
      // The auth listener in _layout.tsx navigates on success.
    } catch (err: any) {
      setError(friendly(err?.message ?? 'Google sign-in failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setError(''); setNotice('');

    if (!email.trim()) return setError('Enter your email address.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (mode === 'signup' && username.trim().length < 2) {
      return setError('Enter a display name of at least 2 characters.');
    }

    setBusy(true);
    try {
      if (mode === 'signin') {
        await signInWithPassword(email.trim(), password);
      } else {
        const { confirmed } = await signUp(email.trim(), password, username.trim());
        if (!confirmed) {
          // Email confirmation is enabled, so there is no session yet. Say so
          // rather than appearing to hang.
          setNotice(`Account created. Open the link we sent to ${email.trim()}, then sign in.`);
          setMode('signin');
          setPassword('');
        }
      }
    } catch (err: any) {
      setError(friendly(err?.message ?? 'Something went wrong.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

        <View style={s.brand}>
          <View style={s.mark}>
            <Text style={s.markText}>TR</Text>
          </View>
          <Text style={s.title}>Territory Runner</Text>
          <Text style={s.sub}>
            {mode === 'signin'
              ? 'Sign in to claim your ground.'
              : 'Start claiming territory on your next run.'}
          </Text>
        </View>

        <View style={s.card}>
          {ENABLE_GOOGLE_OAUTH && (
            <>
              <Pressable
                style={[s.btn, s.btnOauth, busy && s.disabled]}
                onPress={google}
                disabled={busy}
              >
                <Text style={s.btnOauthText}>
                  {mode === 'signin' ? 'Continue with Google' : 'Sign up with Google'}
                </Text>
              </Pressable>

              <View style={s.divider}>
                <View style={s.line} />
                <Text style={s.dividerText}>or</Text>
                <View style={s.line} />
              </View>
            </>
          )}

          {mode === 'signup' && (
            <View style={s.field}>
              <Text style={s.label}>Display name</Text>
              <TextInput
                style={s.input}
                value={username}
                onChangeText={setUsername}
                placeholder="Shown on the leaderboard"
                placeholderTextColor={colors.ink[400]}
                autoCapitalize="words"
                autoCorrect={false}
                editable={!busy}
              />
            </View>
          )}

          <View style={s.field}>
            <Text style={s.label}>Email</Text>
            <TextInput
              style={s.input}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={colors.ink[400]}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              editable={!busy}
            />
          </View>

          <View style={s.field}>
            <Text style={s.label}>Password</Text>
            <TextInput
              style={s.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              editable={!busy}
            />
            {mode === 'signup' && <Text style={s.hint}>At least 8 characters.</Text>}
          </View>

          {!!error && <Text style={s.error}>{error}</Text>}
          {!!notice && <Text style={s.notice}>{notice}</Text>}

          <Pressable
            style={[s.btn, s.btnPrimary, busy && s.disabled]}
            onPress={submit}
            disabled={busy}
          >
            {busy
              ? <ActivityIndicator color={colors.white} />
              : <Text style={s.btnPrimaryText}>
                  {mode === 'signin' ? 'Sign in' : 'Create account'}
                </Text>}
          </Pressable>

          <Pressable
            onPress={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}
            style={s.switchMode}
            disabled={busy}
          >
            <Text style={s.switchText}>
              {mode === 'signin'
                ? "No account? Create one"
                : 'Already have an account? Sign in'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink[100] },
  content: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.xl },

  brand: { alignItems: 'center', gap: spacing.xs },
  mark: {
    width: 52, height: 52, borderRadius: radius.xl,
    backgroundColor: colors.accent[500],
    alignItems: 'center', justifyContent: 'center',
  },
  markText: { color: colors.white, fontSize: 19, fontWeight: '700', letterSpacing: -0.5 },
  title: { ...t.title, color: colors.ink[900], marginTop: spacing.xs },
  sub: { fontSize: 13, color: colors.ink[500], textAlign: 'center' },

  card: {
    backgroundColor: colors.white, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.ink[200],
    padding: spacing.lg, gap: spacing.md, ...shadow.card,
  },

  field: { gap: 5 },
  label: { fontSize: 13, fontWeight: '500', color: colors.ink[700] },
  input: {
    borderWidth: 1, borderColor: colors.ink[300], borderRadius: radius.DEFAULT,
    paddingHorizontal: spacing.md, paddingVertical: 11,
    fontSize: 15, color: colors.ink[900], backgroundColor: colors.white,
  },
  hint: { fontSize: 11, color: colors.ink[500] },

  btn: { borderRadius: radius.DEFAULT, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: colors.accent[600] },
  btnPrimaryText: { color: colors.white, fontSize: 15, fontWeight: '600' },
  // Google's brand guidelines require its button on a white/near-white surface.
  btnOauth: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.ink[300] },
  btnOauthText: { color: colors.ink[800], fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.55 },

  divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  line: { flex: 1, height: 1, backgroundColor: colors.ink[200] },
  dividerText: { fontSize: 11, color: colors.ink[400] },

  error: { fontSize: 12, color: colors.danger, lineHeight: 17 },
  notice: { fontSize: 12, color: colors.success, lineHeight: 17 },

  switchMode: { alignItems: 'center', paddingTop: spacing.xs },
  switchText: { fontSize: 13, color: colors.accent[600], fontWeight: '500' },
});
