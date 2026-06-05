/**
 * Wiring for the login and signup pages.
 *
 * Previously this logic lived in inline <script> blocks inside the two
 * templates, inconsistently with the other pages and unreachable from a CSP
 * that forbids inline script.
 */
(function (window) {
  'use strict';

  var ui = window.TRUi;
  var auth = window.TRAuth;

  function $(id) { return document.getElementById(id); }

  function message(text, isError) {
    var node = $('form-message');
    if (!node) return;
    node.textContent = text || '';
    node.className = 'mt-4 text-center text-xs ' + (isError ? 'text-danger' : 'text-ink-400');
  }

  function busy(on, label) {
    var btn = $('btn-submit');
    if (!btn) return;
    btn.disabled = on;
    btn.textContent = on ? (label || 'Working…') : btn.dataset.label;
  }

  /** Map Supabase's error strings onto something a person can act on. */
  function friendlyError(raw) {
    var m = String(raw || '').toLowerCase();
    if (m.indexOf('invalid login credentials') !== -1) return 'That email and password do not match.';
    if (m.indexOf('email not confirmed') !== -1) return 'Confirm your email address first — check your inbox.';
    if (m.indexOf('already registered') !== -1) return 'That email already has an account. Try signing in.';
    if (m.indexOf('rate limit') !== -1) return 'Too many attempts. Wait a minute and try again.';
    if (m.indexOf('password') !== -1 && m.indexOf('short') !== -1) return 'Password must be at least 8 characters.';
    if (m.indexOf('not configured') !== -1) return raw;   // our own setup error; show it verbatim
    return raw || 'Something went wrong. Please try again.';
  }

  async function init() {
    var submit = $('btn-submit');
    if (submit) submit.dataset.label = submit.textContent;

    // An expired session or a failed OAuth round trip lands back here.
    var params = new URLSearchParams(window.location.search);
    if (params.get('expired')) message('Your session expired. Please sign in again.');

    // Completing an OAuth redirect takes priority over anything else on the
    // page: if it succeeds it navigates away.
    try {
      if (await auth.handleRedirect()) return;
    } catch (err) {
      message(friendlyError(err.message), true);
    }

    var google = $('btn-google');
    if (google) {
      google.addEventListener('click', async function () {
        google.disabled = true;
        try {
          await auth.signInWithProvider('google');
        } catch (err) {
          google.disabled = false;
          message(friendlyError(err.message), true);
        }
      });
    }

    var facebook = $('btn-facebook');
    if (facebook) {
      facebook.addEventListener('click', async function () {
        facebook.disabled = true;
        try {
          await auth.signInWithProvider('facebook');
        } catch (err) {
          facebook.disabled = false;
          message(friendlyError(err.message), true);
        }
      });
    }

    var loginForm = $('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        message('');
        var email = $('email').value.trim();
        var password = $('password').value;
        if (!email || !password) return message('Enter your email and password.', true);

        busy(true, 'Signing in…');
        try {
          await auth.signInWithPassword(email, password);
          window.location.replace(auth.nextUrl());
        } catch (err) {
          busy(false);
          message(friendlyError(err.message), true);
        }
      });
    }

    var signupForm = $('signup-form');
    if (signupForm) {
      signupForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        message('');

        var username = $('username').value.trim();
        var email = $('email').value.trim();
        var password = $('password').value;
        var confirm = $('confirm').value;

        if (username.length < 2) return message('Enter a display name of at least 2 characters.', true);
        if (!email) return message('Enter your email address.', true);
        if (password.length < 8) return message('Password must be at least 8 characters.', true);
        if (password !== confirm) return message('The passwords do not match.', true);

        busy(true, 'Creating account…');
        try {
          var result = await auth.signUp(email, password, username);
          if (result.confirmed) {
            window.location.replace('/');
          } else {
            // Email confirmation is on, so there is no session yet. Say so
            // instead of redirecting to a page that will bounce them back.
            signupForm.hidden = true;
            message('');
            ui.toast('Account created. Check your email to confirm it, then sign in.', 'success', 9000);
            var box = signupForm.parentElement;
            box.insertAdjacentHTML('beforeend',
              '<div class="empty-state"><p class="empty-title">Confirm your email</p>' +
              '<p class="empty-text">We sent a link to ' + ui.escapeHtml(email) +
              '. Open it to activate your account.</p>' +
              '<a href="/login" class="btn-secondary mt-2">Back to sign in</a></div>');
          }
        } catch (err) {
          busy(false);
          message(friendlyError(err.message), true);
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
}(window));
