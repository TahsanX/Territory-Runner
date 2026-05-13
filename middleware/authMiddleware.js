const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

/**
 * Verify a Supabase-issued JWT.
 *
 * Supabase projects now sign user access tokens with an asymmetric JWT signing
 * key (ES256 by default) and publish the public half as JWKS. Older projects
 * still sign with the shared HS256 secret. Both are accepted here, chosen by
 * the token's own `alg` — and each path only ever uses the key material that
 * belongs to it, so an HS256 token can never be validated against the public
 * key (the classic algorithm-confusion attack) and vice versa.
 *
 * Verifying only HS256, as this did before, rejected every token a project on
 * asymmetric keys issues: login appeared to work in the browser and then failed
 * with "Invalid access token" the moment the session was posted to the server.
 */

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const JWKS_URL = process.env.SUPABASE_URL
  ? `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`
  : null;

if (!JWT_SECRET && !JWKS_URL && process.env.NODE_ENV !== 'test') {
  logger.error(
    'Cannot verify tokens: set SUPABASE_URL (for asymmetric signing keys) or ' +
    'SUPABASE_JWT_SECRET (Project Settings -> API -> JWT Settings).'
  );
  process.exit(1);
}

// kid -> KeyObject. Refetched when a token presents an unknown kid, which is
// what key rotation looks like from here.
let jwks = new Map();
let lastFetch = 0;
const REFETCH_COOLDOWN_MS = 30_000;

async function refreshJwks() {
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  const body = await res.json();

  const next = new Map();
  for (const key of body?.keys || []) {
    if (!key.kid) continue;
    try {
      next.set(key.kid, crypto.createPublicKey({ key, format: 'jwk' }));
    } catch (err) {
      logger.warn({ kid: key.kid, err: err.message }, 'Skipping unusable JWKS key');
    }
  }
  if (!next.size) throw new Error('JWKS contained no usable keys');

  jwks = next;
  lastFetch = Date.now();
}

async function publicKeyFor(kid) {
  if (jwks.has(kid)) return jwks.get(kid);

  // A forged token can carry any kid, so refetching is rate-limited rather than
  // driven by whatever arrives.
  if (Date.now() - lastFetch < REFETCH_COOLDOWN_MS) {
    throw new Error(`Unknown signing key ${kid}`);
  }
  await refreshJwks();

  const key = jwks.get(kid);
  if (!key) throw new Error(`Unknown signing key ${kid}`);
  return key;
}

/** Verify and return the raw claims. Throws if the token is not valid. */
async function verifyToken(token) {
  const decoded = jwt.decode(token, { complete: true });
  const alg = decoded?.header?.alg;
  if (!alg) throw new Error('Token has no algorithm header');

  let claims;
  if (alg === 'HS256') {
    if (!JWT_SECRET) throw new Error('HS256 token but SUPABASE_JWT_SECRET is not set');
    claims = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } else if (alg === 'ES256' || alg === 'RS256') {
    if (!JWKS_URL) throw new Error(`${alg} token but SUPABASE_URL is not set`);
    const key = await publicKeyFor(decoded.header.kid);
    claims = jwt.verify(token, key, { algorithms: [alg] });
  } else {
    throw new Error(`Unsupported token algorithm ${alg}`);
  }

  if (!claims.sub) throw new Error('Token has no subject claim');
  return claims;
}

/**
 * Two transports are accepted, deliberately:
 *   - the `sb-access-token` cookie, used by the web app (httpOnly, so it is
 *     not readable by injected scripts the way the old localStorage token was)
 *   - the Authorization: Bearer header, which the Phase 2 mobile app needs
 *     because it cannot use cookies
 */
function extractToken(req) {
  const header = req.headers?.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.['sb-access-token'] || req.cookies?.token || null;
}

async function verify(token) {
  const claims = await verifyToken(token);
  return {
    id: claims.sub,
    email: claims.email,
    role: claims.role,
  };
}

/** Hard gate for API routes. */
async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ message: 'Not signed in.' });
  }
  try {
    req.user = await verify(token);
    return next();
  } catch (err) {
    logger.debug({ err: err.message }, 'Token verification failed');
    return res.status(401).json({ message: 'Session expired. Please sign in again.' });
  }
}

/**
 * Soft gate: populates req.user when a valid token is present but never
 * rejects. Used by the public territory endpoints so they can tell which
 * polygons belong to the viewer (and therefore which get a name label)
 * without requiring a login.
 */
async function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (token) {
    try {
      req.user = await verify(token);
    } catch {
      req.user = null;
    }
  }
  return next();
}

/** For EJS page routes: redirect to /login rather than returning JSON. */
async function requirePage(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  try {
    req.user = await verify(token);
    return next();
  } catch {
    res.clearCookie('sb-access-token');
    res.clearCookie('sb-refresh-token');
    return res.redirect('/login?expired=1');
  }
}

module.exports = requireAuth;
module.exports.requireAuth = requireAuth;
module.exports.optionalAuth = optionalAuth;
module.exports.requirePage = requirePage;
module.exports.extractToken = extractToken;
module.exports.verifyToken = verifyToken;
