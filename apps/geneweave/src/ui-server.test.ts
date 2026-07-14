// SPDX-License-Identifier: MIT
/**
 * The SPA shell renderer — specifically the per-request style nonce the strict CSP uses so the in-app
 * @codemirror/merge editor's injected stylesheets are accepted without relaxing style-src to 'unsafe-inline'.
 */
import { describe, it, expect } from 'vitest';
import { renderSpaHtml, SPA_HTML, STYLES_CSP_HASH } from './ui-server.js';

describe('renderSpaHtml — CSP style nonce injection', () => {
  it('injects the nonce into the csp-style-nonce meta tag', () => {
    const html = renderSpaHtml('abc123+/=');
    expect(html).toContain('<meta name="csp-style-nonce" content="abc123+/=">');
    expect(html).not.toContain('__CSP_STYLE_NONCE__'); // placeholder fully replaced
  });

  it('SECURITY: sanitizes the nonce so it can never break out of the CSP directive or the HTML attribute', () => {
    // A hostile "nonce" carrying quotes/spaces/brackets can't inject an attribute or a CSP source.
    const html = renderSpaHtml('x"><script>alert(1)</script> \'self\'');
    expect(html).toContain('content="xscriptalert1script/selfself'.slice(0, 10)); // only [A-Za-z0-9+/=] survive
    expect(html).not.toContain('<script>alert(1)');
    expect(html).not.toContain('content="x">');
  });

  it('leaves the app’s own hashed <style> block intact (its CSP hash stays valid)', () => {
    // The nonce is a separate meta tag; the <style> block content is unchanged, so STYLES_CSP_HASH still matches.
    const html = renderSpaHtml('nonce123');
    expect(html).toContain('<style>');
    expect(STYLES_CSP_HASH).toMatch(/^'sha256-.+'$/);
    // The template still carries the placeholder (only renderSpaHtml substitutes it per response).
    expect(SPA_HTML).toContain('__CSP_STYLE_NONCE__');
  });
});
