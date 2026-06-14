const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// The GPS filter lives in ../shared and is imported by both the web app and
// this one. Metro refuses to resolve outside the project root unless that root
// is declared as a watch folder.
config.watchFolders = [path.resolve(repoRoot, 'shared')];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
];

module.exports = config;
