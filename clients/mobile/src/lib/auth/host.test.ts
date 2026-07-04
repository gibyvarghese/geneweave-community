import { describe, it, expect } from 'vitest';
import { validateHost, type HostProbe } from './host.js';

const reachable: HostProbe = async () => ({ reachable: true, surfaceId: 'mobile' });
const unreachable: HostProbe = async () => ({ reachable: false });
const throwing: HostProbe = async () => {
  throw new Error('network down');
};

describe('validateHost', () => {
  it('normalizes and accepts a reachable host', async () => {
    const result = await validateHost(reachable, 'api.example.com');
    expect(result).toEqual({ ok: true, host: 'https://api.example.com', surfaceId: 'mobile' });
  });

  it('rejects an unparseable address with a friendly reason', async () => {
    const result = await validateHost(reachable, 'not a url');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/valid server address/i);
  });

  it('rejects an unreachable server with a friendly reason', async () => {
    const result = await validateHost(unreachable, 'api.example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/couldn't reach/i);
  });

  it('treats a thrown probe as unreachable (never propagates)', async () => {
    const result = await validateHost(throwing, 'api.example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.host).toBe('https://api.example.com');
  });

  it('defaults surfaceId to mobile when the probe omits it', async () => {
    const probe: HostProbe = async () => ({ reachable: true });
    const result = await validateHost(probe, 'https://api.example.com');
    expect(result.ok && result.surfaceId).toBe('mobile');
  });
});
