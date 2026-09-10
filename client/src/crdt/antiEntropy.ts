// Anti-entropie : le filet qui rattrape ce que la radio a perdu.
//
// Conception : docs/mesh/protocol.md § 6.3. Il n'existe **pas** de
// resynchronisation complète — elle ne tiendrait pas dans le budget LoRa. Le
// rattrapage est incrémental et repose sur trois mécanismes :
//
//   DIGEST  ce que je détiens, annoncé périodiquement (sous-ensemble tournant)
//   REQ     ce qui me manque, demandé explicitement
//   gigue + suppression   pour qu'un seul nœud réponde, et non tous à la fois
//
// Cette classe ne connaît ni radio ni codec : elle décide **quoi** émettre et
// **quand**, et l'appelant s'occupe de le faire partir. Elle n'utilise aucun
// minuteur non plus — `tick(now)` est appelé de l'extérieur, ce qui rend tout
// le comportement temporel testable sans horloge réelle.

import type { OrderMessage } from '@tq/shared/protocol';
import {
  DIGEST_INTERVAL_MS,
  DIGEST_MAX_ENTRIES,
  RESEND_JITTER_MS,
  RESEND_MAX_PER_DIGEST,
  RESEND_SUPPRESSION_MS,
} from '@tq/shared/mesh/constants';
import { parseOrderId } from '@tq/shared/mesh/ids';
import type { OrderStore } from './orders';
import { VersionVector } from './versionVector';

export interface DigestEntry {
  node: number;
  upto: number;
}

export interface AntiEntropyHooks {
  /** Magasin d'ordres à synchroniser. */
  orders: OrderStore;
  /** Émet un digest (trame DIGEST). */
  sendDigest: (entries: DigestEntry[]) => void;
  /** Demande une plage manquante (trame REQ). */
  sendReq: (node: number, from: number, count: number) => void;
  /** Réémet un ordre déjà détenu, à la demande d'un pair. */
  resendOrder: (order: OrderMessage) => void;
  /** Injectable pour des tests déterministes. */
  random?: () => number;
}

/** Réémission programmée, en attente de sa gigue. */
interface Scheduled {
  orderId: string;
  dueAt: number;
}

/** Demande programmée : une plage qui nous manque, à réclamer après gigue. */
interface ScheduledReq {
  node: number;
  from: number;
  count: number;
  dueAt: number;
}

export class AntiEntropy {
  private readonly held = new VersionVector();
  private readonly hooks: AntiEntropyHooks;
  private readonly random: () => number;
  /** Dernier instant où chaque ordre a été entendu sur la radio. */
  private readonly heardAt = new Map<string, number>();
  private readonly scheduled = new Map<string, Scheduled>();
  private readonly scheduledReqs = new Map<number, ScheduledReq>();
  private lastDigestAt = 0;
  /** Décalage du sous-ensemble tournant annoncé : un digest ne tient pas tout. */
  private digestCursor = 0;

  constructor(hooks: AntiEntropyHooks) {
    this.hooks = hooks;
    this.random = hooks.random ?? Math.random;
  }

  /**
   * Un ordre est entré dans le magasin, qu'il vienne de la radio ou de nous.
   *
   * Marque l'ordre comme entendu : s'il était programmé en réémission, un pair
   * nous a devancés et notre envoi est annulé. C'est le cœur de la suppression.
   */
  observe(order: OrderMessage, now: number): void {
    const id = parseOrderId(order.id);
    if (!id) return; // ordre hérité (uuid) : hors du mécanisme de séquences
    this.held.add(id.node, id.seq);
    this.heardAt.set(order.id, now);
    this.scheduled.delete(order.id);
  }

  /** Retire un ordre du suivi, après compaction du magasin. */
  forget(orderId: string): void {
    const id = parseOrderId(orderId);
    if (id) this.held.remove(id.node, id.seq);
    this.heardAt.delete(orderId);
    this.scheduled.delete(orderId);
  }

  /**
   * Digest reçu d'un pair : on programme la réémission de ce qu'il lui manque
   * et que nous détenons.
   *
   * Chaque envoi part avec une gigue aléatoire. Tous les nœuds qui détiennent
   * l'ordre manquant reçoivent ce digest au même instant : sans ce délai, ils
   * répondraient tous ensemble et se collisionneraient sur le canal.
   */
  onDigest(entries: readonly DigestEntry[], now: number): void {
    let budget = RESEND_MAX_PER_DIGEST;
    for (const entry of entries) {
      // Volet symétrique, sans lequel tout le mécanisme est borgne : un nœud
      // qui a tout raté ne détient rien, n'annonce donc rien, et personne ne
      // peut deviner son retard. C'est en écoutant le digest d'un pair qu'il
      // découvre l'existence d'un auteur et ce qu'il lui manque.
      this.noteOurDeficit(entry, now);
      if (budget <= 0) continue;
      const missing = this.held.heldAbove(entry.node, entry.upto, budget);
      for (const seq of missing) {
        const orderId = formatId(entry.node, seq);
        if (!this.hooks.orders.has(orderId)) continue;
        if (this.isSuppressed(orderId, now)) continue;
        if (this.scheduled.has(orderId)) continue;
        this.scheduled.set(orderId, {
          orderId,
          dueAt: now + Math.floor(this.random() * RESEND_JITTER_MS),
        });
        budget--;
      }
    }
  }

  /**
   * Compare l'annonce d'un pair à ce que nous détenons, et programme une
   * demande pour ce qui nous manque.
   *
   * La demande part avec une gigue, et sa nécessité est revérifiée au moment
   * de l'envoi : si un autre nœud a réclamé entre-temps, la réémission qui
   * s'ensuit est diffusée à tous et notre demande devient inutile.
   */
  private noteOurDeficit(entry: DigestEntry, now: number): void {
    const ours = this.held.contiguousUpto(entry.node);
    if (ours !== null && ours >= entry.upto) return;
    const from = ours === null ? 0 : ours + 1;
    const count = Math.min(entry.upto - from + 1, 255);
    if (count <= 0) return;
    const existing = this.scheduledReqs.get(entry.node);
    if (existing && existing.from <= from) return;
    this.scheduledReqs.set(entry.node, {
      node: entry.node,
      from,
      count,
      dueAt: now + Math.floor(this.random() * RESEND_JITTER_MS),
    });
  }

  /** Requête reçue : un pair demande explicitement une plage. */
  onReq(node: number, from: number, count: number, now: number): void {
    for (let seq = from; seq < from + count; seq++) {
      const orderId = formatId(node, seq);
      if (!this.hooks.orders.has(orderId)) continue;
      if (this.isSuppressed(orderId, now)) continue;
      // Une demande explicite est plus pressante qu'un digest : gigue réduite,
      // mais non nulle — plusieurs nœuds peuvent détenir la même plage.
      this.scheduled.set(orderId, {
        orderId,
        dueAt: now + Math.floor(this.random() * (RESEND_JITTER_MS / 3)),
      });
    }
  }

  /**
   * Battement de l'anti-entropie. À appeler périodiquement ; tout le
   * comportement temporel passe par ici, sans minuteur interne.
   */
  tick(now: number): void {
    this.flushScheduled(now);
    this.flushReqs(now);
    if (now - this.lastDigestAt < DIGEST_INTERVAL_MS) return;
    this.lastDigestAt = now;
    this.emitDigest();
    this.requestGaps(now);
    this.prune(now);
  }

  /**
   * Envoie les demandes dont la gigue est écoulée, après avoir revérifié
   * qu'elles servent encore : la plage a pu être comblée entre-temps par une
   * réémission déclenchée par quelqu'un d'autre.
   */
  private flushReqs(now: number): void {
    for (const [node, req] of this.scheduledReqs) {
      if (req.dueAt > now) continue;
      this.scheduledReqs.delete(node);
      const ours = this.held.contiguousUpto(node);
      const from = ours === null ? req.from : ours + 1;
      const count = req.from + req.count - from;
      if (count > 0) this.hooks.sendReq(node, from, count);
    }
  }

  /** Envoie les réémissions dont la gigue est écoulée. */
  private flushScheduled(now: number): void {
    for (const [orderId, s] of this.scheduled) {
      if (s.dueAt > now) continue;
      this.scheduled.delete(orderId);
      // Dernière vérification : un pair a pu répondre pendant l'attente.
      if (this.isSuppressed(orderId, now)) continue;
      const order = this.hooks.orders.get(orderId);
      if (order) {
        this.heardAt.set(orderId, now);
        this.hooks.resendOrder(order);
      }
    }
  }

  /**
   * Annonce ce qu'on détient, par sous-ensembles tournants.
   *
   * Le vecteur complet ne tient pas dans une trame : à 6 octets par auteur et
   * 40 membres possibles, il ferait 240 octets pour un budget de 200. On
   * annonce donc au plus 32 auteurs à la fois, en tournant d'un digest au
   * suivant pour que tous finissent par être couverts.
   */
  private emitDigest(): void {
    const all = this.held.digestEntries();
    if (all.length === 0) return;
    if (all.length <= DIGEST_MAX_ENTRIES) {
      this.hooks.sendDigest(all);
      return;
    }
    const start = this.digestCursor % all.length;
    const slice = [...all, ...all].slice(start, start + DIGEST_MAX_ENTRIES);
    this.digestCursor = (start + DIGEST_MAX_ENTRIES) % all.length;
    this.hooks.sendDigest(slice);
  }

  /**
   * Demande nos propres trous.
   *
   * Un digest n'annonce que le plus haut numéro contigu : nos trous internes
   * sont invisibles pour les pairs, c'est donc à nous de les réclamer.
   */
  private requestGaps(now: number): void {
    for (const gap of this.held.gaps().slice(0, RESEND_MAX_PER_DIGEST)) {
      if (this.scheduledReqs.has(gap.node)) continue;
      this.scheduledReqs.set(gap.node, {
        node: gap.node,
        from: gap.from,
        count: Math.min(gap.count, 255),
        dueAt: now + Math.floor(this.random() * RESEND_JITTER_MS),
      });
    }
  }

  /** Oublie les échos trop anciens pour peser sur une décision. */
  private prune(now: number): void {
    for (const [orderId, at] of this.heardAt) {
      if (now - at > RESEND_SUPPRESSION_MS * 2) this.heardAt.delete(orderId);
    }
  }

  private isSuppressed(orderId: string, now: number): boolean {
    const at = this.heardAt.get(orderId);
    return at !== undefined && now - at < RESEND_SUPPRESSION_MS;
  }

  /** État interne, pour le diagnostic et les tests. */
  stats(): { authors: number; scheduled: number; gaps: number; requests: number } {
    return {
      authors: this.held.nodes().length,
      scheduled: this.scheduled.size,
      gaps: this.held.gaps().length,
      requests: this.scheduledReqs.size,
    };
  }
}

function formatId(node: number, seq: number): string {
  return `${(node >>> 0).toString(16).padStart(8, '0')}:${(seq & 0xffff).toString(16).padStart(4, '0')}`;
}
