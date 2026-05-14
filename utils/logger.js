const pino = require('pino');

// Replaces ~40 console.log calls, several of which sat in per-GPS-fix hot
// paths. console.log writes to stdout SYNCHRONOUSLY, blocking the event loop
// on every single coordinate; pino is async and level-filtered.
const isDev = process.env.NODE_ENV !== 'production';

// pino-pretty is a devDependency, so it isn't installed in a production
// bundle (e.g. Vercel). NODE_ENV also isn't guaranteed to be 'production' in
// every serverless runtime, so check the module is actually resolvable
// rather than trusting NODE_ENV alone — pino crashes every request if the
// configured transport target can't be found.
let prettyTransport;
if (isDev) {
  try {
    require.resolve('pino-pretty');
    prettyTransport = { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
  } catch {
    // Not installed; fall back to plain JSON logging.
  }
}

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  // Never log credentials or tokens, even at debug level.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'token',
      'access_token',
      'refresh_token',
      '*.password',
      '*.token',
    ],
    censor: '[redacted]',
  },
  transport: prettyTransport,
});

module.exports = logger;
