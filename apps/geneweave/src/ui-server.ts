// SPDX-License-Identifier: MIT
/**
 * geneWeave HTML Generation (Server-side only)
 *
 * Generates the SPA shell served at GET /. Inline <style> and <script> blocks
 * are hashed at startup so the CSP can use sha256 hashes instead of
 * 'unsafe-inline', eliminating the style-src injection vector.
 */

import { createHash } from 'node:crypto';
import { ADMIN_TAB_GROUPS, ADMIN_TABS } from './admin-schema.js';
import { STYLES } from '@weaveintel/geneweave-ui/styles';

function sha256b64(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('base64');
}

// Admin schema JSON — computed once at startup.
const _adminGroupsJson = JSON.stringify(ADMIN_TAB_GROUPS);
const _adminSchemaJson = JSON.stringify(ADMIN_TABS);

// Exact content of the inline <script> block (must match what's in getHTML()).
const _adminScriptContent =
  `\nwindow.ADMIN_GROUPS = ${_adminGroupsJson};\nwindow.ADMIN_SCHEMA = ${_adminSchemaJson};\n`;

// Exact content of the ES-module bootstrap <script type="module"> block.
const _moduleScriptContent =
  `\n  import { initialize } from '/ui.js';\n  if (document.readyState === 'loading') {\n    document.addEventListener('DOMContentLoaded', initialize);\n  } else {\n    initialize();\n  }\n`;

/** sha256 hash of the inline <style> block — use in style-src CSP directive. */
export const STYLES_CSP_HASH = `'sha256-${sha256b64(STYLES)}'`;

/** sha256 hashes of all inline <script> blocks — use in script-src CSP directive. */
export const SCRIPT_CSP_HASHES = [
  `'sha256-${sha256b64(_adminScriptContent)}'`,
  `'sha256-${sha256b64(_moduleScriptContent)}'`,
];

/** Pre-built HTML shell — static after startup, served for every SPA request. */
export const SPA_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>geneWeave</title>
  <style>${STYLES}</style>
  <script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js" crossorigin="anonymous"></script>
</head>
<body>
<div id="root"></div>
<script>${_adminScriptContent}</script>
<script type="module">${_moduleScriptContent}</script>
</body>
</html>`;

/** @deprecated use SPA_HTML directly */
export function getHTML(): string {
  return SPA_HTML;
}
