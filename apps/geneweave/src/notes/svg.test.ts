// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { sanitizeSvg, svgToDataUri, svgToSafeDataUri } from './svg.js';

const OK = '<svg viewBox="0 0 100 100"><path d="M10 10 C 20 0, 40 0, 50 50" fill="#F4C0D1" stroke="#A8281F"/><circle cx="50" cy="50" r="20" fill="red"/><text x="10" y="90">heart</text></svg>';

describe('svg — sanitizeSvg (keeps safe vector art)', () => {
  it('passes a clean illustration + adds the namespace', () => {
    const s = sanitizeSvg(OK)!;
    expect(s).toContain('<path');
    expect(s).toContain('<circle');
    expect(s).toContain('heart');
    expect(s).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
  it('keeps a same-document #fragment href (gradients/defs)', () => {
    const s = sanitizeSvg('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)" href="#g"/></svg>')!;
    expect(s).toContain('href="#g"');
  });
});

describe('svg — sanitizeSvg (SECURITY: strips every active vector)', () => {
  it('removes <script>', () => {
    const s = sanitizeSvg('<svg><script>alert(1)</script><rect/></svg>')!;
    expect(s).not.toContain('<script'); expect(s).toContain('<rect');
  });
  // [SEC][P2] NESTED / split / obfuscated <script> must not survive the regex pass (fail-closed allowlist).
  it('neutralises nested + split + cased + spaced <script> payloads (no executable script leaks)', () => {
    const payloads = [
      '<svg><scr<script>ipt>alert(1)</script></svg>',                 // nested: removing inner reveals outer
      '<svg><script><script>alert(1)</script></script><rect/></svg>', // doubled
      '<svg><ScRiPt>alert(1)</ScRiPt><rect/></svg>',                  // mixed case
      '<svg><script >alert(1)</script ><rect/></svg>',                // space before >
      '<svg><script\ttype="text/javascript">alert(1)</script><rect/></svg>', // tab in tag
      '<svg><script/xlink:href="data:,alert(1)"/></svg>',            // self-closing variant
    ];
    for (const p of payloads) {
      const out = sanitizeSvg(p) ?? '';
      // No executable <script ...> tag survives in any form (case-insensitive).
      expect(out).not.toMatch(/<\s*script/i);
      expect(out).not.toMatch(/<\/\s*script/i);
    }
  });
  it('removes onload / onclick + other event handlers', () => {
    const s = sanitizeSvg('<svg onload="alert(1)"><rect onclick="x()" onmouseover=\'y()\'/></svg>')!;
    expect(s).not.toMatch(/onload|onclick|onmouseover/i);
  });
  it('removes <foreignObject> (HTML/script escape) + media + animation', () => {
    const s = sanitizeSvg('<svg><foreignObject><body><script>1</script></body></foreignObject><animate attributeName="x"/><rect/></svg>')!;
    expect(s.toLowerCase()).not.toContain('foreignobject');
    expect(s.toLowerCase()).not.toContain('<animate');
    expect(s).not.toContain('<script');
  });
  it('strips javascript: + external hrefs (keeps only #fragments)', () => {
    const s = sanitizeSvg('<svg><a href="javascript:alert(1)"><rect/></a><image href="https://evil.com/x.png"/><use xlink:href="https://evil/x"/></svg>')!;
    expect(s).not.toContain('javascript:');
    expect(s).not.toContain('evil.com');
    expect(s).not.toContain('https://evil');
  });
  it('strips DOCTYPE/ENTITY (XXE), comments, CDATA, xml prolog', () => {
    const s = sanitizeSvg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "danger">]><svg><!-- c --><![CDATA[ x ]]><rect/></svg>')!;
    expect(s).not.toMatch(/DOCTYPE|ENTITY|<!--|CDATA/i);
    expect(s).toContain('<rect');
  });
  it('strips style="url(...)" + expression(...)', () => {
    const s = sanitizeSvg('<svg><rect style="fill:red;background:url(http://evil/x)"/><rect style=\'width:expression(alert(1))\'/></svg>')!;
    expect(s).not.toContain('url('); expect(s).not.toContain('expression(');
  });
  it('refuses non-SVG / oversize / junk', () => {
    expect(sanitizeSvg('<div>not svg</div>')).toBeNull();
    expect(sanitizeSvg('')).toBeNull();
    expect(sanitizeSvg(null)).toBeNull();
    expect(sanitizeSvg(42)).toBeNull();
    expect(sanitizeSvg('<svg>' + 'x'.repeat(300_000) + '</svg>')).toBeNull();
  });
  it('STRESS: 200 hostile SVGs never throw + never leak script/js/onload', () => {
    for (let i = 0; i < 200; i++) {
      const hostile = `<svg onload="a${i}()"><script>${i}</script><a href="javascript:${i}"><rect style="x:expression(${i})"/></a></svg>`;
      const out = sanitizeSvg(hostile);
      if (out) { expect(out).not.toContain('<script'); expect(out).not.toMatch(/onload/i); expect(out).not.toContain('javascript:'); expect(out).not.toContain('expression('); }
    }
  });
});

describe('svg — sanitizeSvg (Phase 0-D hardening: namespace + SMIL + data-URI + allowlist)', () => {
  it('catches NAMESPACE-PREFIXED dangerous elements (<svg:script>, <x:foreignObject>)', () => {
    const s = sanitizeSvg('<svg><svg:script>alert(1)</svg:script><x:foreignObject><b>hi</b></x:foreignObject><rect/></svg>')!;
    expect(s.toLowerCase()).not.toContain('script');
    expect(s.toLowerCase()).not.toContain('foreignobject');
    expect(s).toContain('<rect');
  });
  it('strips ALL SMIL animation (animate can mutate an attr to javascript: after sanitising)', () => {
    const s = sanitizeSvg('<svg><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="onload" to="alert(1)"/><animateTransform/><mpath/><rect/></svg>')!;
    for (const t of ['<animate', '<set', '<animatetransform', '<mpath']) expect(s.toLowerCase()).not.toContain(t);
    expect(s).not.toContain('javascript:');
  });
  it('rejects data:text/html and data:image/svg+xml hrefs but keeps a safe raster data:image', () => {
    const s = sanitizeSvg('<svg><a href="data:text/html,<script>alert(1)</script>"><rect/></a><image href="data:image/svg+xml;base64,PHN2Zz4="/><image href="data:image/png;base64,iVBORw0KGgo="/></svg>')!;
    expect(s).not.toContain('data:text/html');
    expect(s).not.toContain('data:image/svg+xml');
    expect(s).toContain('data:image/png;base64'); // safe raster preserved
  });
  it('defangs control-char-obfuscated javascript: in href (java\\tscript:)', () => {
    const s = sanitizeSvg('<svg><a href="java\tscript:alert(1)"><rect/></a></svg>')!;
    expect(s.replace(/\s/g, '').toLowerCase()).not.toContain('javascript:alert');
  });
  it('strips vbscript: and an xmlns binding to the XHTML namespace', () => {
    const s = sanitizeSvg('<svg xmlns:h="http://www.w3.org/1999/xhtml"><a href="vbscript:msgbox(1)"><rect/></a></svg>')!;
    expect(s.toLowerCase()).not.toContain('vbscript:');
    expect(s.toLowerCase()).not.toContain('1999/xhtml');
  });
  it('FAIL-CLOSED: an unknown/novel element has its tag stripped (allowlist)', () => {
    const s = sanitizeSvg('<svg><weirdcustomtag onload="x()">text</weirdcustomtag><rect/></svg>')!;
    expect(s.toLowerCase()).not.toContain('weirdcustomtag');
    expect(s).not.toMatch(/onload/i);
    expect(s).toContain('<rect'); // the safe element survives
  });
  it('keeps the full safe allowlist (gradients, filters, text) intact', () => {
    const rich = '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs><g><path d="M0 0L10 10"/><text x="1" y="9"><tspan>hi</tspan></text></g></svg>';
    const s = sanitizeSvg(rich)!;
    for (const el of ['lineargradient', 'stop', 'filter', 'fegaussianblur', '<g', '<path', '<text', '<tspan']) expect(s.toLowerCase()).toContain(el);
  });
});

describe('svg — data URIs', () => {
  it('makes an inert data:image/svg+xml URI', () => {
    const uri = svgToDataUri('<svg><rect/></svg>');
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });
  it('svgToSafeDataUri sanitises then encodes, or null for unsafe', () => {
    expect(svgToSafeDataUri(OK)!.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(svgToSafeDataUri('<div>x</div>')).toBeNull();
    // a script-laden svg is sanitised before encoding (not rejected).
    const safe = svgToSafeDataUri('<svg><script>alert(1)</script><rect/></svg>')!;
    const decoded = Buffer.from(safe.split(',')[1]!, 'base64').toString('utf8');
    expect(decoded).not.toContain('<script');
  });
});
