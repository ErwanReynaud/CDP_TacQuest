import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEFAULT_ROLE,
  DISCONNECT_GRACE_MS,
  MAX_MEMBERS_PER_ROOM,
  MAX_RECENT_ORDERS,
  MAX_ROOMS,
  ORDER_MAX_PER_WINDOW,
  ORDER_WINDOW_MS,
  POSITION_MIN_INTERVAL_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_EMPTY_TTL_MS,
} from '@tq/shared/constants';
import type {
  ErrorCode,
  MemberPublic,
  OrderMessage,
  Position,
  RoomState,
} from '@tq/shared/protocol';

export interface Member {
  id: string;
  /** Secret de re-binding — jamais exposé dans MemberPublic. */
  sessionToken: string;
  callsign: string;
  /** Poste dans l'arbre de commandement (cf. ROLE_REGEX). */
  role: string;
  isLeader: boolean;
  connected: boolean;
  lastSeen: number;
  lastPosition: Position | null;
  socketId: string | null;
  lastPositionAcceptedAt: number;
  /** Throttle des ordres (fenêtre fixe) : début de fenêtre et compte courant. */
  orderWindowStart: number;
  ordersInWindow: number;
}

export interface Room {
  code: string;
  createdAt: number;
  /** Instant où la room a perdu son dernier membre connecté, null sinon. */
  emptySince: number | null;
  members: Map<string, Member>;
  recentOrders: OrderMessage[];
}

/** Snapshot sérialisable d'une room (JSON sur disque, cf. persistence.ts). */
export interface RoomSnapshot {
  code: string;
  createdAt: number;
  emptySince: number | null;
  members: Member[];
  recentOrders: OrderMessage[];
}

/** Photo complète de l'état serveur, écrite/rechargée sur le volume. */
export interface ManagerSnapshot {
  version: 1;
  savedAt: number;
  rooms: RoomSnapshot[];
}

/** Membre tel qu'affiché dans la console d'administration. */
export interface MemberSummary {
  id: string;
  callsign: string;
  isLeader: boolean;
  connected: boolean;
  lastSeen: number;
}

/** Room telle qu'affichée dans la console d'administration. */
export interface RoomSummary {
  code: string;
  createdAt: number;
  emptySince: number | null;
  /** Instant d'expiration (24 h après la dernière connexion) ; null si la
   *  room est occupée — TTL glissant, elle n'expire pas tant qu'on y est. */
  expiresAt: number | null;
  expiresInMs: number | null;
  memberCount: number;
  connectedCount: number;
  orderCount: number;
  members: MemberSummary[];
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: ErrorCode };

/**
 * Garde de type vers la branche d'échec. On ne se repose PAS sur le
 * rétrécissement de `if (!res.ok)` : soustraire le membre par intersection
 * `{ ok: true } & T` d'une union échoue selon la version de TypeScript (OK en
 * local, KO sur d'autres builds — ex. Vercel). Un prédicat explicite narrow de
 * façon fiable partout.
 */
export function isErr<T>(r: Result<T>): r is { ok: false; error: ErrorCode } {
  return !r.ok;
}

export interface SweepEvents {
  /** Membres dont la période de grâce a expiré. */
  memberTimeouts: { roomCode: string; memberId: string }[];
  /** Rooms supprimées (vides trop longtemps ou trop vieilles). */
  closedRooms: string[];
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  createRoom(callsign: string, role: string, socketId: string, now = Date.now()): Result<{ room: Room; member: Member }> {
    if (this.rooms.size >= MAX_ROOMS) return { ok: false, error: 'SERVER_FULL' };
    const room: Room = {
      code: this.generateCode(),
      createdAt: now,
      emptySince: null,
      members: new Map(),
      recentOrders: [],
    };
    this.rooms.set(room.code, room);
    const member = this.addMember(room, callsign, role, socketId, true, now);
    return { ok: true, room, member };
  }

  joinRoom(
    code: string,
    callsign: string,
    role: string,
    socketId: string,
    now = Date.now(),
    replace = false,
  ): Result<{ room: Room; member: Member; replacedMemberId?: string }> {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
    // Deux clés d'unicité : l'indicatif (toujours) et le poste de commandement
    // (sauf GV, non contraint). Un membre connecté tenant l'une ou l'autre bloque
    // net ; un fantôme déconnecté est remplaçable sur confirmation explicite.
    const members = [...room.members.values()];
    const byCallsign = members.find((m) => m.callsign.toLowerCase() === callsign.toLowerCase());
    const byRole = role === 'GV' ? undefined : members.find((m) => m.role === role);
    if (byCallsign?.connected) return { ok: false, error: 'CALLSIGN_TAKEN' };
    if (byRole?.connected) return { ok: false, error: 'POST_TAKEN' };
    // À ce stade, byCallsign/byRole ne peuvent être que des fantômes déconnectés.
    if (byRole && !replace) return { ok: false, error: 'POST_TAKEN_DISCONNECTED' };
    if (byCallsign && !replace) return { ok: false, error: 'CALLSIGN_TAKEN_DISCONNECTED' };
    let replacedMemberId: string | undefined;
    for (const ghost of new Set([byCallsign, byRole].filter((m): m is Member => m != null))) {
      room.members.delete(ghost.id); // évince le fantôme, libère une place
      replacedMemberId = ghost.id;
    }
    if (room.members.size >= MAX_MEMBERS_PER_ROOM) return { ok: false, error: 'ROOM_FULL' };
    const member = this.addMember(room, callsign, role, socketId, false, now);
    return { ok: true, room, member, replacedMemberId };
  }

  rejoin(code: string, memberId: string, sessionToken: string, socketId: string, now = Date.now()): Result<{ room: Room; member: Member }> {
    const room = this.rooms.get(code);
    const member = room?.members.get(memberId);
    if (!room || !member || member.sessionToken !== sessionToken) {
      return { ok: false, error: 'SESSION_INVALID' };
    }
    member.connected = true;
    member.socketId = socketId;
    member.lastSeen = now;
    room.emptySince = null;
    return { ok: true, room, member };
  }

  /** Déconnexion socket : le membre reste en grâce (DISCONNECT_GRACE_MS). */
  markDisconnected(code: string, memberId: string, now = Date.now()): Member | null {
    const room = this.rooms.get(code);
    const member = room?.members.get(memberId);
    if (!room || !member) return null;
    member.connected = false;
    member.socketId = null;
    member.lastSeen = now;
    this.refreshEmptySince(room, now);
    return member;
  }

  /** Départ explicite : suppression immédiate, pas de grâce. */
  leave(code: string, memberId: string, now = Date.now()): boolean {
    const room = this.rooms.get(code);
    if (!room || !room.members.delete(memberId)) return false;
    this.refreshEmptySince(room, now);
    return true;
  }

  /** Throttle serveur des positions. Retourne false si le fix est rejeté. */
  acceptPosition(member: Member, position: Position, now = Date.now()): boolean {
    if (now - member.lastPositionAcceptedAt < POSITION_MIN_INTERVAL_MS) return false;
    member.lastPositionAcceptedAt = now;
    member.lastPosition = position;
    member.lastSeen = now;
    return true;
  }

  /**
   * Throttle anti-flood des ordres, par membre (fenêtre fixe ORDER_WINDOW_MS).
   * Retourne false si le membre a dépassé ORDER_MAX_PER_WINDOW dans la fenêtre
   * courante — l'appelant ne diffuse alors pas l'ordre. Repli sur 0 pour les
   * champs absents des snapshots antérieurs à ce throttle.
   */
  acceptOrder(member: Member, now = Date.now()): boolean {
    const start = member.orderWindowStart || 0;
    if (now - start >= ORDER_WINDOW_MS) {
      member.orderWindowStart = now;
      member.ordersInWindow = 0;
    }
    if ((member.ordersInWindow || 0) >= ORDER_MAX_PER_WINDOW) return false;
    member.ordersInWindow = (member.ordersInWindow || 0) + 1;
    return true;
  }

  /**
   * Ajoute un ordre à l'historique de la salle, borné à MAX_RECENT_ORDERS.
   *
   * L'éviction cible d'abord les ordres **transitoires** — messages de chat et
   * accusés de réception. Ce sont eux qui font le volume sur une longue
   * session, et une éviction purement chronologique finissait par jeter des
   * figurés au profit de bavardages : un client qui se reconnecte, ou qui
   * arrive en cours de mission, ne recevait alors jamais des tracés que tous
   * les autres voyaient.
   */
  pushOrder(room: Room, order: OrderMessage): void {
    room.recentOrders.push(order);
    if (room.recentOrders.length <= MAX_RECENT_ORDERS) return;
    const transient = room.recentOrders.findIndex(
      (o) => o.payload.kind === 'text' || o.payload.kind === 'ack',
    );
    room.recentOrders.splice(transient >= 0 ? transient : 0, 1);
  }

  /** GC périodique : grâce des membres, rooms sans connexion depuis 24 h.
   *  TTL glissant : une room occupée (au moins un connecté) ne meurt jamais ;
   *  le compte à rebours de 24 h part de la dernière déconnexion. */
  sweep(now = Date.now()): SweepEvents {
    const events: SweepEvents = { memberTimeouts: [], closedRooms: [] };
    for (const room of this.rooms.values()) {
      for (const member of room.members.values()) {
        if (!member.connected && now - member.lastSeen > DISCONNECT_GRACE_MS) {
          room.members.delete(member.id);
          events.memberTimeouts.push({ roomCode: room.code, memberId: member.id });
        }
      }
      this.refreshEmptySince(room, now);
      if (room.emptySince !== null && now - room.emptySince > ROOM_EMPTY_TTL_MS) {
        this.rooms.delete(room.code);
        events.closedRooms.push(room.code);
      }
    }
    return events;
  }

  // --- Administration (cf. admin.ts) ---------------------------------------

  /** Clôture immédiate d'une room (l'émission des événements incombe à l'appelant). */
  closeRoom(code: string): boolean {
    return this.rooms.delete(code);
  }

  /**
   * Rallonge la durée de vie d'une room. Avec le TTL glissant, seule une room
   * sans connexion a une échéance : on redémarre son compte à rebours "vide"
   * (emptySince=now, nouvelle fenêtre ROOM_EMPTY_TTL_MS). Une room occupée
   * n'expire pas — l'extension est alors sans effet.
   */
  extendRoom(code: string, now = Date.now()): boolean {
    const room = this.rooms.get(code);
    if (!room) return false;
    const hasConnected = [...room.members.values()].some((m) => m.connected);
    room.emptySince = hasConnected ? null : now;
    return true;
  }

  /**
   * Exclut un membre. Renvoie le membre retiré (avec son socketId, pour que
   * l'appelant déconnecte le socket) ou null. La room reste ouverte.
   */
  kickMember(code: string, memberId: string, now = Date.now()): Member | null {
    const room = this.rooms.get(code);
    const member = room?.members.get(memberId);
    if (!room || !member) return null;
    room.members.delete(memberId);
    this.refreshEmptySince(room, now);
    return member;
  }

  /** Vue synthétique de toutes les rooms pour la console d'administration. */
  summarize(now = Date.now()): RoomSummary[] {
    return [...this.rooms.values()].map((room) => {
      const members = [...room.members.values()];
      const expiresAt = room.emptySince === null ? null : room.emptySince + ROOM_EMPTY_TTL_MS;
      return {
        code: room.code,
        createdAt: room.createdAt,
        emptySince: room.emptySince,
        expiresAt,
        expiresInMs: expiresAt === null ? null : Math.max(0, expiresAt - now),
        memberCount: members.length,
        connectedCount: members.filter((m) => m.connected).length,
        orderCount: room.recentOrders.length,
        members: members
          .map((m) => ({
            id: m.id,
            callsign: m.callsign,
            isLeader: m.isLeader,
            connected: m.connected,
            lastSeen: m.lastSeen,
          }))
          .sort((a, b) => Number(b.isLeader) - Number(a.isLeader) || a.callsign.localeCompare(b.callsign)),
      };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Photo sérialisable de toutes les rooms, pour la persistance disque. */
  snapshot(): ManagerSnapshot {
    return {
      version: 1,
      savedAt: Date.now(),
      rooms: [...this.rooms.values()].map((room) => ({
        code: room.code,
        createdAt: room.createdAt,
        emptySince: room.emptySince,
        members: [...room.members.values()],
        recentOrders: room.recentOrders,
      })),
    };
  }

  /**
   * Restaure l'état depuis un snapshot, au démarrage du process. Tous les
   * membres repartent déconnectés : aucun socket ne survit à un redémarrage.
   * Ils restent en période de grâce et se re-binderont via `rejoin`
   * (sessionToken) dès que leur PWA se reconnecte. Sur snapshot invalide on ne
   * touche à rien (démarrage à vide).
   */
  restore(snap: ManagerSnapshot, now = Date.now()): void {
    if (!snap || snap.version !== 1 || !Array.isArray(snap.rooms)) return;
    this.rooms.clear();
    for (const rs of snap.rooms) {
      const members = new Map<string, Member>();
      for (const m of rs.members ?? []) {
        // Repli pour les snapshots antérieurs à la refonte des rôles (champ `sidc`).
        const role = m.role ?? DEFAULT_ROLE;
        members.set(m.id, { ...m, role, connected: false, socketId: null });
      }
      const room: Room = {
        code: rs.code,
        createdAt: rs.createdAt,
        emptySince: rs.emptySince,
        members,
        recentOrders: rs.recentOrders ?? [],
      };
      this.rooms.set(room.code, room);
      // Plus personne de connecté : (re)déclenche le compte à rebours "vide".
      this.refreshEmptySince(room, now);
    }
  }

  memberPublic(m: Member): MemberPublic {
    return {
      id: m.id,
      callsign: m.callsign,
      role: m.role,
      isLeader: m.isLeader,
      connected: m.connected,
      lastSeen: m.lastSeen,
      lastPosition: m.lastPosition,
    };
  }

  roomState(room: Room): RoomState {
    return {
      code: room.code,
      members: [...room.members.values()].map((m) => this.memberPublic(m)),
      recentOrders: room.recentOrders,
    };
  }

  private addMember(
    room: Room,
    callsign: string,
    role: string,
    socketId: string,
    isLeader: boolean,
    now: number,
  ): Member {
    const member: Member = {
      id: randomUUID(),
      sessionToken: randomBytes(16).toString('hex'),
      callsign,
      role,
      isLeader,
      connected: true,
      lastSeen: now,
      lastPosition: null,
      socketId,
      lastPositionAcceptedAt: 0,
      orderWindowStart: 0,
      ordersInWindow: 0,
    };
    room.members.set(member.id, member);
    room.emptySince = null;
    return member;
  }

  private refreshEmptySince(room: Room, now: number): void {
    const hasConnected = [...room.members.values()].some((m) => m.connected);
    if (hasConnected) room.emptySince = null;
    else if (room.emptySince === null) room.emptySince = now;
  }

  private generateCode(): string {
    for (;;) {
      let code = '';
      const bytes = randomBytes(ROOM_CODE_LENGTH);
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length];
      }
      if (!this.rooms.has(code)) return code;
    }
  }
}
