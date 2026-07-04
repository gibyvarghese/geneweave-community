// Empty RN shim for Node built-ins that only appear in server-only, dead-code
// paths of bundled workspace packages (e.g. `@weaveintel/core/net-guard` pulls
// `node:dns`/`node:net` for SSRF checks the mobile client never runs — it talks
// to a single configured host via the global `fetch`). Named imports against
// this module resolve to `undefined`; they are never invoked on device.
module.exports = {};
