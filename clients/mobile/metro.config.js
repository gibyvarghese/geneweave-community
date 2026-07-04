// Metro config for the geneWeave mobile app inside the npm-workspaces monorepo.
// Metro must (1) watch the workspace root so symlinked workspace packages
// (@weaveintel/tokens, @weaveintel/api-client and their deps) are seen, and
// (2) resolve modules from both the package-local and the hoisted root
// node_modules. See https://docs.expo.dev/guides/monorepos/.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Only resolve from the explicit nodeModulesPaths above (avoid Metro walking
// up and picking up duplicate copies of react / react-native).
config.resolver.disableHierarchicalLookup = true;

// The logic layer (src/lib, src/native) and the workspace packages are authored
// in NodeNext TypeScript, which requires explicit ".js" extensions on relative
// imports even though the on-disk file is ".ts"/".tsx". Metro resolves the
// literal "./foo.js" and fails. Strip the ".js" so Metro's own sourceExts
// (ts, tsx, js, ...) can pick the real file.
const defaultResolveRequest = config.resolver.resolveRequest;

// React Native has no Node standard library. A few bundled workspace packages
// reference Node built-ins: `@weaveintel/core` mints UUIDv7s via
// `node:crypto`'s randomBytes (real, needed → Expo CSPRNG shim) and pulls
// `node:dns`/`node:net` for server-only SSRF guards (dead code on device →
// empty shim). Map those specifiers to local shims.
const nodeBuiltinShims = {
  'node:crypto': path.resolve(projectRoot, 'shims/node-crypto.js'),
  crypto: path.resolve(projectRoot, 'shims/node-crypto.js'),
  'node:dns': path.resolve(projectRoot, 'shims/empty.js'),
  'node:dns/promises': path.resolve(projectRoot, 'shims/empty.js'),
  'node:net': path.resolve(projectRoot, 'shims/empty.js'),
  // `undici` is only reached through core's server-only hardened egress
  // (net-guard / hardened-fetch); the client uses the global `fetch`.
  undici: path.resolve(projectRoot, 'shims/empty.js'),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const shim = nodeBuiltinShims[moduleName];
  if (shim) {
    return { type: 'sourceFile', filePath: shim };
  }
  if (
    /\.js$/.test(moduleName) &&
    (moduleName.startsWith('./') || moduleName.startsWith('../'))
  ) {
    const withoutExt = moduleName.replace(/\.js$/, '');
    try {
      return context.resolveRequest(context, withoutExt, platform);
    } catch {
      // Fall through to the default resolution for genuine .js files.
    }
  }
  return (defaultResolveRequest ?? context.resolveRequest)(
    context,
    moduleName,
    platform,
  );
};

module.exports = config;
