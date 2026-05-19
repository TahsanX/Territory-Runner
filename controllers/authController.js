const Profile = require('../models/Profile');
const UserStatistics = require('../models/UserStatistics');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/authMiddleware');

/**
 * Supabase Auth owns registration, login, password hashing, OAuth and token
 * issuance, so the old register/login handlers are gone along with bcrypt and
 * the hand-signed JWT. What remains is profile reading and the session-cookie
 * exchange.
 */

const COOKIE_BASE = {
  httpOnly: true,                                    // not readable by injected scripts
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
};

/**
 * Exchange Supabase tokens for httpOnly cookies.
 *
 * The browser completes sign-in with supabase-js and posts the resulting
 * session here. Previously the JWT was kept in localStorage, which is readable
 * by any injected script; it also could not be read during server-side EJS
 * rendering, which is why the page-level auth guard never worked.
 */
exports.createSession = async (req, res, next) => {
  try {
    const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = req.body || {};

    if (!accessToken) {
      return res.status(400).json({ message: 'access_token is required.' });
    }

    // Validate before trusting it, so a forged token cannot be stored as a cookie.
    let claims;
    try {
      claims = await verifyToken(accessToken);
    } catch (err) {
      logger.debug({ err: err.message }, 'Session token rejected');
      return res.status(401).json({ message: 'Invalid access token.' });
    }

    const maxAge = (Number(expiresIn) || 3600) * 1000;
    res.cookie('sb-access-token', accessToken, { ...COOKIE_BASE, maxAge });
    if (refreshToken) {
      res.cookie('sb-refresh-token', refreshToken, {
        ...COOKIE_BASE,
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    }

    // Safety net for accounts created before the on_auth_user_created trigger
    // existed; normally the row is already there.
    await Profile.ensureExists(claims.sub, {
      username: claims.user_metadata?.username
        || claims.user_metadata?.full_name
        || claims.user_metadata?.name
        || (claims.email ? claims.email.split('@')[0] : null),
      avatarUrl: claims.user_metadata?.avatar_url,
    });

    logger.info({ userId: claims.sub }, 'Session established');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

exports.destroySession = (req, res) => {
  res.clearCookie('sb-access-token', { path: '/' });
  res.clearCookie('sb-refresh-token', { path: '/' });
  res.json({ ok: true });
};

exports.getUserProfile = async (req, res, next) => {
  try {
    const profile = await Profile.findWithStats(req.user.id);
    if (!profile) return res.status(404).json({ message: 'Profile not found.' });

    const [areaRank, distanceRank] = await Promise.all([
      UserStatistics.rankFor(req.user.id, 'area'),
      UserStatistics.rankFor(req.user.id, 'distance'),
    ]);

    res.json({
      user: {
        id: profile.id,
        username: profile.username,
        email: req.user.email,
        avatarUrl: profile.avatar_url,
        weightKg: Number(profile.weight_kg),
        createdAt: profile.created_at,
      },
      stats: {
        totalDistance: Number(profile.total_distance),
        totalTime: profile.total_time,
        totalCalories: profile.total_calories,
        totalTerritoryArea: Number(profile.total_territory_area),
        totalRunningSessions: profile.total_running_sessions,
      },
      ranks: { area: areaRank, distance: distanceRank },
    });
  } catch (err) {
    next(err);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const { username, weightKg } = req.body || {};

    if (username !== undefined) {
      const name = String(username).trim();
      if (name.length < 2 || name.length > 50) {
        return res.status(400).json({ message: 'Username must be 2-50 characters.' });
      }
    }
    if (weightKg !== undefined) {
      const w = Number(weightKg);
      if (!Number.isFinite(w) || w <= 20 || w >= 400) {
        return res.status(400).json({ message: 'Weight must be between 20 and 400 kg.' });
      }
    }

    const updated = await Profile.update(req.user.id, {
      username: username !== undefined ? String(username).trim() : undefined,
      weightKg: weightKg !== undefined ? Number(weightKg) : undefined,
    });
    if (!updated) return res.status(404).json({ message: 'Profile not found.' });

    res.json({ user: updated });
  } catch (err) {
    // 23505 is Postgres' unique_violation, raised by the UNIQUE on username.
    if (err.code === '23505') {
      return res.status(409).json({ message: 'That username is already taken.' });
    }
    next(err);
  }
};

/** Public config the browser needs. Only ever the anon key — never service-role. */
exports.getPublicConfig = (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    enableFacebook: process.env.ENABLE_FACEBOOK_OAUTH === 'true',
    enableGoogle: process.env.ENABLE_GOOGLE_OAUTH === 'true',
    maptilerKey: process.env.MAPTILER_KEY || null,
    maptilerStyle: process.env.MAPTILER_STYLE || 'streets-v2',
  });
};
