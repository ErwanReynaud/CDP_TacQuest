import { describe, expect, it } from 'vitest';
import {
  ADMIN_AUTH_MAX_FAILS,
  ADMIN_AUTH_WINDOW_MS,
  JOIN_FAIL_MAX,
  JOIN_FAIL_WINDOW_MS,
} from '@tq/shared/constants';
import { AdminAuthLimiter, JoinRateLimiter } from './rateLimit';

const IP = '203.0.113.7';
const T0 = 1_000_000;

describe('AdminAuthLimiter', () => {
  it('verrouille l’IP après ADMIN_AUTH_MAX_FAILS échecs', () => {
    const lim = new AdminAuthLimiter();
    for (let i = 0; i < ADMIN_AUTH_MAX_FAILS; i++) {
      expect(lim.allow(IP, T0)).toBe(true);
      lim.recordFailure(IP, T0);
    }
    expect(lim.allow(IP, T0)).toBe(false);
  });

  it('un succès remet le compteur à zéro', () => {
    const lim = new AdminAuthLimiter();
    for (let i = 0; i < ADMIN_AUTH_MAX_FAILS; i++) lim.recordFailure(IP, T0);
    expect(lim.allow(IP, T0)).toBe(false);
    lim.reset(IP);
    expect(lim.allow(IP, T0)).toBe(true);
  });

  it('déverrouille après la fenêtre glissante', () => {
    const lim = new AdminAuthLimiter();
    for (let i = 0; i < ADMIN_AUTH_MAX_FAILS; i++) lim.recordFailure(IP, T0);
    expect(lim.allow(IP, T0 + ADMIN_AUTH_WINDOW_MS - 1)).toBe(false);
    expect(lim.allow(IP, T0 + ADMIN_AUTH_WINDOW_MS + 1)).toBe(true);
  });

  it('isole les IP entre elles', () => {
    const lim = new AdminAuthLimiter();
    for (let i = 0; i < ADMIN_AUTH_MAX_FAILS; i++) lim.recordFailure(IP, T0);
    expect(lim.allow('198.51.100.1', T0)).toBe(true);
  });
});

describe('JoinRateLimiter', () => {
  it('verrouille l’IP après JOIN_FAIL_MAX échecs (codes inconnus)', () => {
    const lim = new JoinRateLimiter();
    for (let i = 0; i < JOIN_FAIL_MAX; i++) {
      expect(lim.allow(IP, T0)).toBe(true);
      lim.recordFailure(IP, T0);
    }
    expect(lim.allow(IP, T0)).toBe(false);
  });

  it('un join réussi (reset) rouvre les tentatives', () => {
    const lim = new JoinRateLimiter();
    for (let i = 0; i < JOIN_FAIL_MAX; i++) lim.recordFailure(IP, T0);
    expect(lim.allow(IP, T0)).toBe(false);
    lim.reset(IP);
    expect(lim.allow(IP, T0)).toBe(true);
  });

  it('déverrouille après la fenêtre glissante', () => {
    const lim = new JoinRateLimiter();
    for (let i = 0; i < JOIN_FAIL_MAX; i++) lim.recordFailure(IP, T0);
    expect(lim.allow(IP, T0 + JOIN_FAIL_WINDOW_MS - 1)).toBe(false);
    expect(lim.allow(IP, T0 + JOIN_FAIL_WINDOW_MS + 1)).toBe(true);
  });
});
