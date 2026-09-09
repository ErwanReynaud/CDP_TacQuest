import { describe, expect, it } from 'vitest';
import { headerLookupFrom, resolveClientIp } from './clientIp';

describe('resolveClientIp', () => {
  it('préfère Fly-Client-IP (non usurpable) à X-Forwarded-For', () => {
    const get = headerLookupFrom({
      'fly-client-ip': '203.0.113.9',
      'x-forwarded-for': '1.2.3.4',
    });
    expect(resolveClientIp(get, 'fallback')).toBe('203.0.113.9');
  });

  it('retombe sur le premier X-Forwarded-For si pas de Fly-Client-IP', () => {
    const get = headerLookupFrom({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' });
    expect(resolveClientIp(get, 'fallback')).toBe('198.51.100.7');
  });

  it('utilise le fallback (adresse socket) sans en-tête de proxy', () => {
    const get = headerLookupFrom({});
    expect(resolveClientIp(get, '::1')).toBe('::1');
  });

  it('gère un en-tête livré en tableau (Socket.IO)', () => {
    const get = headerLookupFrom({ 'fly-client-ip': ['203.0.113.9'] });
    expect(resolveClientIp(get, 'fallback')).toBe('203.0.113.9');
  });
});
