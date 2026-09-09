import {
  ADMIN_AUTH_MAX_FAILS,
  ADMIN_AUTH_WINDOW_MS,
  JOIN_FAIL_MAX,
  JOIN_FAIL_WINDOW_MS,
  ROOM_CREATE_PER_IP_PER_HOUR,
} from '@tq/shared/constants';

const WINDOW_MS = 60 * 60_000;

/** Limiteur glissant en mémoire : créations de room par IP. */
export class IpRateLimiter {
  private readonly creations = new Map<string, number[]>();

  tryCreate(ip: string, now = Date.now()): boolean {
    const recent = (this.creations.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= ROOM_CREATE_PER_IP_PER_HOUR) {
      this.creations.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.creations.set(ip, recent);
    return true;
  }
}

/**
 * Verrou anti brute-force générique : compte les échecs par IP sur une fenêtre
 * glissante. Au-delà de `maxFails`, l'IP est bloquée jusqu'à expiration de la
 * fenêtre ; un succès (`reset`) remet le compteur à zéro. Sert au code admin
 * comme aux tentatives de join sur code inconnu.
 */
export class FailureWindow {
  private readonly fails = new Map<string, number[]>();

  constructor(
    private readonly maxFails: number,
    private readonly windowMs: number,
  ) {}

  /** Vrai si l'IP a encore le droit de tenter (non verrouillée). */
  allow(ip: string, now = Date.now()): boolean {
    return this.recent(ip, now).length < this.maxFails;
  }

  /** Enregistre un échec. */
  recordFailure(ip: string, now = Date.now()): void {
    const recent = this.recent(ip, now);
    recent.push(now);
    this.fails.set(ip, recent);
  }

  /** Succès : on oublie les échecs de cette IP. */
  reset(ip: string): void {
    this.fails.delete(ip);
  }

  /** Secondes avant déverrouillage (pour l'en-tête Retry-After). */
  retryAfterSec(ip: string, now = Date.now()): number {
    const recent = this.recent(ip, now);
    if (!recent.length) return 0;
    return Math.ceil((recent[0]! + this.windowMs - now) / 1000);
  }

  private recent(ip: string, now: number): number[] {
    const recent = (this.fails.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(ip, recent);
    return recent;
  }
}

/** Verrou anti brute-force du code admin (échecs d'authentification par IP). */
export class AdminAuthLimiter extends FailureWindow {
  constructor() {
    super(ADMIN_AUTH_MAX_FAILS, ADMIN_AUTH_WINDOW_MS);
  }
}

/** Verrou anti brute-force du code de salle (join sur code inconnu, par IP). */
export class JoinRateLimiter extends FailureWindow {
  constructor() {
    super(JOIN_FAIL_MAX, JOIN_FAIL_WINDOW_MS);
  }
}
