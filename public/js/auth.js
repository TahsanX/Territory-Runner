/**
 * Supabase Auth client: Google OAuth, optional Facebook, and email/password.
 *
 * This replaces the hand-rolled flow entirely — there is no bcrypt, no
 * self-signed JWT, and no passport/express-session on the server. It also
 * moves the token out of localStorage: after sign-in the session is posted to
 * /api/auth/session, which sets it as an httpOnly cookie. That is both safer
 * against script injection and the only way the server can read auth while
 * rendering a page, which is what makes the page-level guard work.
 *
 * Account linking is Supabase's job: signing in with Google using an email
 * that already exists links the provider instead of creating a second user.
 */
(function (window) {
  'use strict';

  var cfg = window.TR_CONFIG || {};
  var client = null;

  function getClient() {
    if (client) return client;
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
    }
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('The Supabase client library failed to load.');
    }
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,   // required to complete the OAuth redirect
        storageKey: 'tr-session',
      },
    });
    return client;
  }

  /** Hand the verified session to the server, which sets the httpOnly cookies. */
  async function syncSession(session) {
    if (!session || !session.access_token) throw new Error('No session to sync');
    await window.TRApi.post('/api/auth/session', {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
    }, { allowUnauthorized: true });
  }

  function nextUrl() {
    var params = new URLSearchParams(window.location.search);
    var next = params.get('next');
    // Only allow same-site paths: an open redirect here would be a phishing
    // vector straight out of the login page.
    if (next && next.startsWith('/') && !next.startsWith('//')) return next;
    return '/';
  }

  async function signInWithProvider(provider) {
    // The buttons are not rendered when a provider is disabled; this refuses the
    // call itself, so a disabled provider cannot be reached from the console
    // either. Supabase would reject it too, but with a less obvious message.
    if (provider === 'google' && !cfg.enableGoogle) {
      throw new Error('Google sign-in is not enabled. Use email and password.');
    }
    if (provider === 'facebook' && !cfg.enableFacebook) {
      throw new Error('Facebook sign-in is not enabled. Use email and password.');
    }
    var supa = getClient();
    var { error } = await supa.auth.signInWithOAuth({
      provider: provider,
      options: {
        redirectTo: window.location.origin + '/login?next=' + encodeURIComponent(nextUrl()),
        queryParams: provider === 'google'
          ? { access_type: 'offline', prompt: 'consent' }
          : undefined,
      },
    });
    if (error) throw new Error(error.message);
  }

  async function signInWithPassword(email, password) {
    var supa = getClient();
    var { data, error } = await supa.auth.signInWithPassword({ email: email, password: password });
    if (error) throw new Error(error.message);
    await syncSession(data.session);
    return data;
  }

  async function signUp(email, password, username) {
    var supa = getClient();
    var { data, error } = await supa.auth.signUp({
      email: email,
      password: password,
      // Read by the on_auth_user_created trigger to name the profile row.
      options: { data: { username: username } },
    });
    if (error) throw new Error(error.message);

    // With email confirmation enabled Supabase returns no session yet, so the
    // caller must tell the user to check their inbox rather than redirecting.
    if (data.session) {
      await syncSession(data.session);
      return { confirmed: true };
    }
    return { confirmed: false };
  }

  async function signOut() {
    try { await getClient().auth.signOut(); } catch (e) { /* cookie clear still matters */ }
    try { window.localStorage.removeItem('tr-session'); } catch (e) { /* private mode */ }
  }

  /**
   * Completes an OAuth redirect. detectSessionInUrl has already parsed the
   * fragment by the time this runs; all that remains is handing the session to
   * the server and moving on.
   */
  async function handleRedirect() {
    var hasAuthFragment = /[#&](access_token|error_description)=/.test(window.location.hash);
    var hasAuthQuery = /[?&](code|error_description)=/.test(window.location.search);
    if (!hasAuthFragment && !hasAuthQuery) return false;

    var supa = getClient();
    var { data, error } = await supa.auth.getSession();
    if (error) throw new Error(error.message);
    if (!data.session) {
      var params = new URLSearchParams(window.location.hash.slice(1));
      var desc = params.get('error_description') ||
                 new URLSearchParams(window.location.search).get('error_description');
      if (desc) throw new Error(desc);
      return false;
    }

    await syncSession(data.session);
    window.location.replace(nextUrl());
    return true;
  }

  window.TRAuth = {
    getClient: getClient,
    signInWithProvider: signInWithProvider,
    signInWithPassword: signInWithPassword,
    signUp: signUp,
    signOut: signOut,
    handleRedirect: handleRedirect,
    syncSession: syncSession,
    nextUrl: nextUrl,
  };
}(window));
