// Vercel entry point. Rewriting every path to a root-level file (/server.js)
// made Express see "/server.js" as the request path, so no route ever matched.
// A function under api/ keeps the original URL intact.
module.exports = require('../server.js');
