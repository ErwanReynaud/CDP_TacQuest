// Gouverneur d'airtime : arbitre ce qui part sur la radio, et quand.
//
// Sans lui, rien ne borne les émissions côté client. Les garde-fous du mode
// serveur n'ont aucun sens ici : ORDER_MAX_PER_WINDOW autorise 5 messages par
// seconde, quand le budget légal EU868 n'en permet qu'environ 75 **par heure**
// (cf. shared/src/mesh/airtime.ts). Et il n'y a pas de serveur pour renvoyer
// RATE_LIMITED : la limitation doit être locale, avant émission.
//
// L'arbitrage est une file par priorité, pas une simple limitation de débit :
// quand le budget se resserre, ce sont les envois les moins urgents qu'il faut
// sacrifier, pas les plus anciens.

import { DutyCycleBudget, type LoRaParams, MESH_PRESETS, timeOnAirMs } from '@tq/shared/mesh/airtime';
import { DUTY_CYCLE_EU868 } from '@tq/shared/mesh/constants';

/**
 * Priorités, de la plus forte à la plus faible.
 *
 * L'ordre traduit une doctrine, pas une commodité technique : une alerte de
 * contact passe avant un tracé, un tracé avant une position (qui sera de toute
 * façon remplacée au relevé suivant), et une position avant un digest
 * d'anti-entropie, qui n'est qu'un filet de sécurité.
 */
export const PRIORITIES = ['alert', 'order', 'position', 'digest'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** En-tête MeshPacket ajouté par le firmware à notre charge utile. */
const MESH_HEADER_BYTES = 16;

export interface Envelope {
  bytes: Uint8Array;
  priority: Priority;
  send: () => Promise<void>;
  /**
   * Clé de fusion : une nouvelle entrée de même clé remplace la précédente
   * encore en attente. Une position périmée n'a aucune valeur une fois qu'une
   * plus récente existe — l'émettre gaspillerait de l'airtime pour afficher un
   * équipier là où il n'est plus.
   */
  coalesceKey?: string;
}

interface Queued extends Envelope {
  queuedAt: number;
  airtimeMs: number;
}

export interface GovernorOptions {
  params?: LoRaParams;
  /** Fraction du temps d'émission autorisée (0,01 en EU868). */
  dutyCycle?: number;
  /** Profondeur maximale de la file, toutes priorités confondues. */
  maxQueue?: number;
  log?: (message: string) => void;
}

export interface GovernorStats {
  queued: number;
  sent: number;
  dropped: number;
  coalesced: number;
  /** Part du budget horaire consommée, de 0 à 1. */
  load: number;
  usedMs: number;
  remainingMs: number;
}

export class AirtimeGovernor {
  private readonly budget: DutyCycleBudget;
  private readonly params: LoRaParams;
  private readonly maxQueue: number;
  private readonly log: (m: string) => void;
  private readonly queue: Queued[] = [];
  private sent = 0;
  private dropped = 0;
  private coalesced = 0;

  constructor(opts: GovernorOptions = {}) {
    this.params = opts.params ?? MESH_PRESETS.LongFast;
    this.budget = new DutyCycleBudget(opts.dutyCycle ?? DUTY_CYCLE_EU868);
    this.maxQueue = opts.maxQueue ?? 64;
    this.log = opts.log ?? (() => {});
  }

  /** Coût radio d'une charge utile applicative, en-tête Meshtastic compris. */
  airtimeOf(payloadBytes: number): number {
    return timeOnAirMs(payloadBytes + MESH_HEADER_BYTES, this.params);
  }

  /**
   * Soumet une trame. Renvoie `true` si elle a été émise ou mise en file,
   * `false` si elle a été écartée.
   *
   * Le cas courant — canal libre — passe immédiatement : on ne veut aucune
   * latence artificielle quand le budget le permet.
   */
  submit(env: Envelope, now = Date.now()): boolean {
    const airtimeMs = this.airtimeOf(env.bytes.length);

    if (this.queue.length === 0 && this.budget.canSend(airtimeMs, now)) {
      this.dispatch({ ...env, queuedAt: now, airtimeMs }, now);
      return true;
    }

    if (env.coalesceKey) {
      const i = this.queue.findIndex((q) => q.coalesceKey === env.coalesceKey);
      if (i >= 0) {
        // Remplacement plutôt qu'ajout : une seule position en attente, la
        // plus récente.
        this.queue[i] = { ...env, queuedAt: now, airtimeMs };
        this.coalesced++;
        return true;
      }
    }

    if (this.queue.length >= this.maxQueue) {
      // File pleine : on sacrifie la moins prioritaire, à condition qu'elle le
      // soit strictement moins que la nouvelle. Sinon c'est la nouvelle qui
      // tombe — une avalanche de digests ne doit pas évincer des ordres.
      const worst = this.lowestPriorityIndex();
      if (worst >= 0 && rank(this.queue[worst]!.priority) > rank(env.priority)) {
        this.queue.splice(worst, 1);
        this.dropped++;
      } else {
        this.dropped++;
        this.log(`[airtime] trame ${env.priority} écartée : file saturée`);
        return false;
      }
    }

    this.queue.push({ ...env, queuedAt: now, airtimeMs });
    return true;
  }

  /**
   * Émet ce que le budget permet, du plus prioritaire au plus ancien.
   * Renvoie le nombre de trames parties.
   */
  drain(now = Date.now()): number {
    let count = 0;
    for (;;) {
      const i = this.nextIndex();
      if (i < 0) break;
      const item = this.queue[i]!;
      if (!this.budget.canSend(item.airtimeMs, now)) break;
      this.queue.splice(i, 1);
      this.dispatch(item, now);
      count++;
    }
    return count;
  }

  /** Index de la prochaine trame à émettre : priorité d'abord, ancienneté ensuite. */
  private nextIndex(): number {
    let best = -1;
    for (let i = 0; i < this.queue.length; i++) {
      if (best < 0) {
        best = i;
        continue;
      }
      const a = this.queue[i]!;
      const b = this.queue[best]!;
      if (rank(a.priority) < rank(b.priority)) best = i;
      else if (rank(a.priority) === rank(b.priority) && a.queuedAt < b.queuedAt) best = i;
    }
    return best;
  }

  private lowestPriorityIndex(): number {
    let worst = -1;
    for (let i = 0; i < this.queue.length; i++) {
      if (worst < 0 || rank(this.queue[i]!.priority) > rank(this.queue[worst]!.priority)) worst = i;
    }
    return worst;
  }

  private dispatch(item: Queued, now: number): void {
    this.budget.record(item.airtimeMs, now);
    this.sent++;
    void item.send();
  }

  /** Nombre de trames en attente, par priorité. */
  pending(priority?: Priority): number {
    return priority ? this.queue.filter((q) => q.priority === priority).length : this.queue.length;
  }

  stats(now = Date.now()): GovernorStats {
    return {
      queued: this.queue.length,
      sent: this.sent,
      dropped: this.dropped,
      coalesced: this.coalesced,
      load: this.budget.load(now),
      usedMs: Math.round(this.budget.usedMs(now)),
      remainingMs: Math.round(this.budget.remainingMs(now)),
    };
  }

  /**
   * Intervalle recommandé entre deux positions, en millisecondes.
   *
   * Les positions sont le poste dominant : à 120 s elles consomment déjà près
   * de la moitié du budget horaire. Plutôt qu'une constante qui devine, on
   * espace en fonction de la charge réelle — ce qui laisse la place aux ordres
   * quand la manœuvre s'intensifie, et la rend au suivi quand elle retombe.
   */
  recommendedPositionIntervalMs(base: number, now = Date.now()): number {
    const load = this.budget.load(now);
    if (load < 0.5) return base;
    if (load < 0.75) return base * 2;
    return base * 4;
  }
}

function rank(p: Priority): number {
  return PRIORITIES.indexOf(p);
}
