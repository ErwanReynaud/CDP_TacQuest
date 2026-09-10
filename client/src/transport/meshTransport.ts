// Transport mesh : radio Meshtastic ↔ état applicatif.
//
// Seul endroit où le codec binaire, le CRDT et une radio se rencontrent.
// Au-dessus, la logique applicative ne voit que des OrderMessage et des
// Position, sans savoir par quel chemin ils sont passés.

import type { MemberPublic, OrderMessage, Position } from '@tq/shared/protocol';
import { MESH_MISSION_IDS, MESH_POSITION_INTERVAL_MS } from '@tq/shared/mesh/constants';
import { MeshCodecError } from '@tq/shared/mesh/bytes';
import {
  type ControlFrame,
  type DecodeContext,
  decodeFrame,
  encodeAnchor,
  encodeDigest,
  encodeOrderFitted,
  encodeRelay,
  encodeReq,
  nodeToMemberId,
  RELAY_INNER_BUDGET,
} from '@tq/shared/mesh/codec';
import { OP } from '@tq/shared/mesh/constants';
import { type Anchor, canonicalAnchor } from '@tq/shared/mesh/geo';
import { parseOrderId } from '@tq/shared/mesh/ids';
import { AntiEntropy } from '../crdt/antiEntropy';
import { mergeOrder, type OrderStore } from '../crdt/orders';
import { PositionRegister } from '../crdt/positions';
import type { Radio } from '../mesh/radio';
import { bus, type BusEvent, state } from '../state';
import { localNode } from './orderIds';

/** Époque des horodatages d'une salle mesh, en secondes Unix. */
export interface MeshRoom {
  anchor: Anchor;
  epochSec: number;
}

export interface MeshTransportOptions {
  radio: Radio;
  /** Ancre et époque de la salle. Déduites du premier fix si absentes. */
  room?: MeshRoom;
  /** Journal de diagnostic (branché sur debugLog en production). */
  log?: (message: string) => void;
  /**
   * État visé. Par défaut l'état global de l'application ; injectable pour
   * faire tourner plusieurs nœuds isolés dans un même processus de test.
   */
  orders?: OrderStore;
  members?: Map<string, MemberPublic>;
  emit?: (event: BusEvent, detail?: unknown) => void;
  /**
   * Horloge. Injectable pour que les tests pilotent le temps : l'anti-entropie
   * raisonne en gigue et en fenêtres de suppression, et mélanger horloge réelle
   * et temps simulé rendrait tout son comportement intestable.
   */
  now?: () => number;
}

export class MeshTransport {
  readonly kind = 'mesh' as const;
  private readonly radio: Radio;
  private readonly positions = new PositionRegister();
  private readonly unsubscribes: (() => void)[] = [];
  private readonly log: (m: string) => void;
  private readonly orders: OrderStore;
  private readonly members: Map<string, MemberPublic>;
  private readonly emit: (event: BusEvent, detail?: unknown) => void;
  private readonly now: () => number;
  private room: MeshRoom | null;
  private lastPositionSent = 0;
  private readonly antiEntropy: AntiEntropy;
  /** Ordres qu'on n'a pas pu émettre faute d'ancre : rejoués dès qu'elle existe. */
  private readonly pending: OrderMessage[] = [];

  constructor(opts: MeshTransportOptions) {
    this.radio = opts.radio;
    this.room = opts.room ?? null;
    this.log = opts.log ?? (() => {});
    this.orders = opts.orders ?? state.orders;
    this.members = opts.members ?? state.members;
    this.emit = opts.emit ?? ((e, d) => bus.emit(e, d));
    this.now = opts.now ?? (() => Date.now());
    // L'anti-entropie décide quoi réémettre et quand ; c'est ici qu'on lui
    // fournit de quoi le faire partir sur la radio.
    this.antiEntropy = new AntiEntropy({
      orders: this.orders,
      sendDigest: (entries) => void this.radio.sendPrivate(encodeDigest(entries)),
      sendReq: (node, from, count) => void this.radio.sendPrivate(encodeReq(node, from, count)),
      resendOrder: (o) => void this.sendOrder(o),
    });
    this.wire();
  }

  get online(): boolean {
    return this.radio.status === 'connected';
  }

  /** Ancre courante, ou `null` tant qu'aucune n'a été fixée ni reçue. */
  get anchor(): Anchor | null {
    return this.room?.anchor ?? null;
  }

  private ctx(from: number): DecodeContext {
    const room = this.room;
    if (!room) throw new MeshCodecError('aucune ancre de zone connue');
    return { anchor: room.anchor, epochSec: room.epochSec, missions: MESH_MISSION_IDS, from };
  }

  private wire(): void {
    this.unsubscribes.push(
      this.radio.on('private', (payload, from) => this.onPrivate(payload, from)),
      this.radio.on('position', (from, position) => this.onPosition(from, position)),
      this.radio.on('user', (from, user) => this.onUser(from, user.callsign)),
      this.radio.on('error', (m) => this.log(`[mesh] ${m}`)),
    );
  }

  private onPrivate(payload: Uint8Array, from: number): void {
    let frame;
    try {
      frame = decodeFrame(payload, this.ctx(from));
    } catch (err) {
      // Une trame illisible (version inconnue, corruption radio) ne doit pas
      // interrompre la réception : on la journalise et on continue.
      this.log(`[mesh] trame ignorée de ${from} : ${String(err)}`);
      return;
    }

    if (frame.kind === 'control') {
      this.onControl(frame.frame);
      return;
    }
    // Observer même un doublon : c'est ce qui fait taire notre propre
    // réémission quand un pair nous a devancés.
    this.antiEntropy.observe(frame.order, this.now());
    if (mergeOrder(this.orders, frame.order)) this.emit('orders');
  }

  private onControl(frame: ControlFrame): void {
    const now = this.now();
    switch (frame.op) {
      case OP.ANCHOR:
        // On adopte l'ancre annoncée si on n'en avait pas. La règle de
        // convergence complète (originator, puis plus petit numéro de nœud)
        // est spécifiée dans docs/mesh/protocol.md § 3.
        if (!this.room) {
          this.room = { anchor: frame.anchor, epochSec: frame.epochSec };
          this.log('[mesh] ancre de zone adoptée');
          this.flushPending();
        }
        break;
      case OP.DIGEST:
        this.antiEntropy.onDigest(frame.entries, now);
        break;
      case OP.REQ:
        this.antiEntropy.onReq(frame.node, frame.from, frame.count, now);
        break;
      case OP.MEMBER:
        this.onUser(0, frame.callsign);
        break;
    }
  }

  private onPosition(from: number, position: Position): void {
    const memberId = nodeToMemberId(from);
    if (!this.positions.apply(memberId, position, from)) return;
    const member = this.members.get(memberId);
    if (member) {
      member.lastPosition = position;
      member.lastSeen = this.now();
      this.emit('position', memberId);
    }
  }

  private onUser(from: number, callsign: string): void {
    const memberId = nodeToMemberId(from);
    const existing = this.members.get(memberId);
    if (existing) {
      if (existing.callsign === callsign && existing.connected) return;
      existing.callsign = callsign;
      existing.connected = true;
      existing.lastSeen = this.now();
    } else {
      this.members.set(memberId, {
        id: memberId,
        callsign,
        role: 'GV',
        isLeader: false,
        connected: true,
        lastSeen: this.now(),
        lastPosition: this.positions.get(memberId) ?? null,
      });
    }
    this.emit('members');
  }

  /**
   * Fixe l'ancre de zone à partir d'une position, si aucune n'existe encore.
   * Arrondie au 0,01° pour que deux nœuds du même secteur tombent le plus
   * souvent sur la même valeur sans se concerter.
   */
  ensureAnchor(lat: number, lng: number): void {
    if (this.room) return;
    this.room = { anchor: canonicalAnchor(lat, lng), epochSec: Math.floor(this.now() / 1000) };
    this.log('[mesh] ancre de zone établie');
    void this.radio.sendPrivate(encodeAnchor(this.room.anchor, this.room.epochSec, true));
    this.flushPending();
  }

  private flushPending(): void {
    const queued = this.pending.splice(0, this.pending.length);
    for (const o of queued) void this.sendOrder(o);
  }

  /**
   * Émet un ordre sur la radio. Renvoie `false` s'il n'a pas pu partir — à
   * l'appelant de décider (file d'attente, repli serveur, message).
   */
  async sendOrder(order: OrderMessage): Promise<boolean> {
    if (!this.room) {
      // Pas encore d'ancre : on garde l'ordre plutôt que de le perdre.
      this.pending.push(order);
      return false;
    }
    // Le codec élide l'auteur : le destinataire le reconstruit depuis
    // l'en-tête du paquet. Un ordre qui n'est pas le nôtre doit donc partir
    // dans une enveloppe RELAY portant son auteur, sinon il serait attribué à
    // notre module — et un `remove` viserait le mauvais figuré.
    const parsed = parseOrderId(order.id);
    if (!parsed) {
      // Identifiant hérité (uuid) : rien à quoi rattacher une séquence.
      this.log(`[mesh] ordre ${order.id} non émis : identifiant hors format mesh`);
      return false;
    }
    const ours = this.radio.nodeNum ?? localNode();
    const relayed = parsed.node !== ours;
    try {
      const budget = relayed ? RELAY_INNER_BUDGET : undefined;
      const { bytes, droppedPoints } = encodeOrderFitted(order, this.ctx(0), budget);
      if (droppedPoints > 0) {
        this.log(`[mesh] tracé simplifié : ${droppedPoints} sommet(s) retiré(s)`);
      }
      await this.radio.sendPrivate(relayed ? encodeRelay(parsed.node, bytes) : bytes);
      this.antiEntropy.observe(order, this.now());
      return true;
    } catch (err) {
      this.log(`[mesh] ordre ${order.id} non encodable : ${String(err)}`);
      return false;
    }
  }

  /**
   * Émet notre position, en respectant la cadence mesh.
   *
   * Bien plus lente qu'en mode serveur : 40 nœuds toutes les 30 s satureraient
   * le canal à eux seuls. Renvoie `false` si l'envoi a été écarté par la
   * cadence — ce n'est pas une erreur.
   */
  sendPosition(p: Position, now = this.now()): boolean {
    this.ensureAnchor(p.lat, p.lng);
    if (now - this.lastPositionSent < MESH_POSITION_INTERVAL_MS) return false;
    this.lastPositionSent = now;
    void this.radio.sendPosition(p);
    return true;
  }

  /** Publie notre indicatif sur le mesh (NODEINFO_APP). */
  announce(callsign: string): void {
    void this.radio.setOwner({ callsign, shortName: callsign.slice(0, 4).toUpperCase() });
  }

  /**
   * Battement de l'anti-entropie : émission périodique du digest, réémissions
   * dont la gigue est écoulée, demandes de nos propres trous.
   *
   * Piloté de l'extérieur plutôt que par un minuteur interne, pour que le
   * comportement temporel reste testable sans horloge réelle.
   */
  tick(now = this.now()): void {
    this.antiEntropy.tick(now);
  }

  /** État de synchronisation, pour le panneau de diagnostic. */
  syncStats(): { authors: number; scheduled: number; gaps: number; requests: number } {
    return this.antiEntropy.stats();
  }

  stop(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.positions.clear();
  }
}
