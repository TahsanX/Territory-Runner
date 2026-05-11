require('dotenv').config();

const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');

const logger = require('./utils/logger');
const { healthCheck } = require('./config/database');
const { requirePage, optionalAuth } = require('./middleware/authMiddleware');

const authRoutes = require('./routes/authRoutes');
const runRoutes = require('./routes/runRoutes');
const territoryRoutes = require('./routes/territoryRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');
const statsRoutes = require('./routes/statsRoutes');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Behind nginx on the droplet: needed for correct protocol detection, which in
// turn governs whether `secure` cookies are actually set.
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Security and transport
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Supabase's client and MapLibre/Leaflet come from a CDN; the inline
      // bootstrap in each page needs 'unsafe-inline' until it is extracted.
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://*.supabase.co', 'https://api.maptiler.com',
                   'https://nominatim.openstreetmap.org', 'https://api.geoapify.com'],
      workerSrc: ["'self'", 'blob:'],
      // In dev the app is opened over plain http from phones on the LAN; this
      // directive would rewrite every asset URL to https and break the page.
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  hsts: isProd,
  // Map tiles and marker sprites are cross-origin.
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Request logging, replacing the per-route console.log calls. Health checks
// are excluded or they dominate the log on a monitored droplet.
app.use(require('pino-http')({
  logger,
  autoLogging: { ignore: (req) => req.url === '/api/health' },
}));

// ---------------------------------------------------------------------------
// Static assets
//
// Long-lived immutable caching in production. The previous bare express.static
// sent no cache headers at all, so every asset was re-fetched on every page.
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: isProd ? '30d' : 0,
  etag: true,
  lastModified: true,
}));
app.use('/shared', express.static(path.join(__dirname, 'shared'), {
  maxAge: isProd ? '30d' : 0,
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isProd) app.set('view cache', true);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/run', runRoutes);
app.use('/api/territory', territoryRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/stats', statsRoutes);

/**
 * Health check that actually checks.
 *
 * The old one returned 200 unconditionally while the database connection
 * handler was written to keep the process alive on failure — so a dead
 * database reported a healthy service and every API call 500'd. This also
 * doubles as the keep-warm ping that stops a free-tier Supabase project
 * pausing after 7 days of inactivity.
 */
app.get('/api/health', async (req, res) => {
  try {
    await healthCheck();
    res.json({ status: 'ok', database: 'up', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', database: 'down', error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const render = (view, title) => (req, res) =>
  res.render(view, {
    title,
    user: req.user || null,
    maptilerKey: process.env.MAPTILER_KEY || '',
    maptilerStyle: process.env.MAPTILER_STYLE || 'streets-v2',
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    enableFacebook: process.env.ENABLE_FACEBOOK_OAUTH === 'true',
    enableGoogle: process.env.ENABLE_GOOGLE_OAUTH === 'true',
  });

app.get('/login', optionalAuth, (req, res, next) => {
  if (req.user) return res.redirect('/');
  return render('login', 'Sign in')(req, res, next);
});
app.get('/signup', optionalAuth, (req, res, next) => {
  if (req.user) return res.redirect('/');
  return render('signup', 'Create account')(req, res, next);
});

// requirePage is now actually applied. The equivalent middleware previously
// existed but was never attached to any route, so every page was public.
app.get('/', requirePage, render('home', 'Dashboard'));
app.get('/run', requirePage, render('run', 'Live run'));
app.get('/summary', requirePage, render('summary', 'Summary'));
app.get('/leaderboard', optionalAuth, render('leaderboard', 'Leaderboard'));

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// HTML for page requests, JSON for the API. The old catch-all returned JSON
// for unknown page URLs too.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ message: 'Not found.' });
  }
  return res.status(404).render('404', { title: 'Not found', user: null });
});

app.use((err, req, res, _next) => {
  logger.error({ err, url: req.originalUrl }, 'Request failed');
  const body = { message: 'Something went wrong.' };
  // Never leak stack traces or driver messages in production.
  if (!isProd) body.error = err.message;
  if (req.path.startsWith('/api/')) return res.status(500).json(body);
  return res.status(500).render('500', { title: 'Error', user: null });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// Only bind a port when run directly (`node server.js`, Render, nodemon). When
// a serverless host such as Vercel imports this file it supplies its own
// listener and calls the exported `app` per request, so listening here would
// fight it.
if (require.main === module) {
  const server = app.listen(PORT, () => {
    logger.info(`Territory Runner listening on http://localhost:${PORT}`);
    if (!process.env.MAPTILER_KEY) {
      logger.warn('MAPTILER_KEY is not set — falling back to OpenStreetMap raster tiles.');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${PORT} is already in use.`);
    } else {
      logger.error({ err }, 'Server error');
    }
    process.exit(1);
  });

  const shutdown = (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

module.exports = app;
