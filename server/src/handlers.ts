import type { Server, Socket } from 'socket.io';
import {
  CALLSIGN_REGEX,
  FAILED_JOIN_DELAY_MS,
  GC_INTERVAL_MS,
  MAX_ORDER_BYTES,
  ROLE_REGEX,
} from '@tq/shared/constants';
import type {
  ClientToServerEvents,
  ErrorCode,
  OrderMessage,
  Position,
  ServerToClientEvents,
} from '@tq/shared/protocol';
import { isErr } from './rooms';
import type { Member, Room, RoomManager } from './rooms';
import { JoinRateLimiter, type IpRateLimiter } from './rateLimit';
import { headerLookupFrom, resolveClientIp } from './clientIp';

interface SocketData {
  roomCode?: string;
  memberId?: string;
}

type TqServer = Server<ClientToServerEvents, ServerToClientEvents, Record<never, never>, SocketData>;
type TqSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<never, never>, SocketData>;

function isValidCallsign(v: unknown): v is string {
  return typeof v === 'string' && CALLSIGN_REGEX.test(v.trim());
}

function isValidRole(v: unknown): v is string {
  return typeof v === 'string' && ROLE_REGEX.test(v);
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidPosition(p: unknown): p is Position {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    isFiniteNum(o.lat) && o.lat >= -90 && o.lat <= 90 &&
    isFiniteNum(o.lng) && o.lng >= -180 && o.lng <= 180 &&
    isFiniteNum(o.accuracy) && o.accuracy >= 0 &&
    (o.heading === null || isFiniteNum(o.heading)) &&
    (o.speed === null || isFiniteNum(o.speed)) &&
    isFiniteNum(o.ts)
  );
}

export function registerHandlers(io: TqServer, manager: RoomManager, limiter: IpRateLimiter): () => void {
  const joinLimiter = new JoinRateLimiter();
  io.on('connection', (socket) => {
    // IP réelle du client : derrière Fly/Caddy, socket.handshake.address est
    // l'IP interne du proxy (identique pour tous) — inutilisable pour du
    // rate-limiting. On lit Fly-Client-IP / X-Forwarded-For (cf. clientIp.ts).
    const ip = resolveClientIp(
      headerLookupFrom(socket.handshake.headers),
      socket.handshake.address,
    );

    const fail = (ack: (res: { ok: false; error: ErrorCode }) => void, error: ErrorCode, delayed = false) => {
      if (typeof ack !== 'function') return;
      if (delayed) setTimeout(() => ack({ ok: false, error }), FAILED_JOIN_DELAY_MS);
      else ack({ ok: false, error });
    };

    const currentMember = (): { room: Room; member: Member } | null => {
      const { roomCode, memberId } = socket.data;
      if (!roomCode || !memberId) return null;
      const room = manager.rooms.get(roomCode);
      const member = room?.members.get(memberId);
      return room && member ? { room, member } : null;
    };

    const enterRoom = (socket: TqSocket, room: Room, member: Member) => {
      socket.data.roomCode = room.code;
      socket.data.memberId = member.id;
      void socket.join(room.code);
    };

    socket.on('create_room', (p, ack) => {
      if (typeof ack !== 'function') return;
      if (!p || !isValidCallsign(p.callsign) || !isValidRole(p.role)) return fail(ack, 'INVALID_PAYLOAD');
      if (!limiter.tryCreate(ip)) return fail(ack, 'RATE_LIMITED');
      const res = manager.createRoom(p.callsign.trim(), p.role, socket.id);
      if (isErr(res)) return fail(ack, res.error);
      enterRoom(socket, res.room, res.member);
      ack({
        ok: true,
        roomCode: res.room.code,
        memberId: res.member.id,
        sessionToken: res.member.sessionToken,
        roomState: manager.roomState(res.room),
      });
    });

    socket.on('join_room', (p, ack) => {
      if (typeof ack !== 'function') return;
      if (!p || typeof p.roomCode !== 'string' || !isValidCallsign(p.callsign) || !isValidRole(p.role)) {
        return fail(ack, 'INVALID_PAYLOAD');
      }
      // Verrou anti brute-force : trop d'essais de code inconnu depuis cette IP.
      if (!joinLimiter.allow(ip)) return fail(ack, 'RATE_LIMITED', true);
      const code = p.roomCode.trim().toUpperCase();
      const res = manager.joinRoom(code, p.callsign.trim(), p.role, socket.id, undefined, p.replace === true);
      if (isErr(res)) {
        // Seul un code inconnu compte comme tentative de brute-force ; les autres
        // erreurs (indicatif/poste pris) prouvent que le code était bon.
        if (res.error === 'ROOM_NOT_FOUND') joinLimiter.recordFailure(ip);
        // Délai sur ROOM_NOT_FOUND : ralentit le brute-force des codes.
        return fail(ack, res.error, res.error === 'ROOM_NOT_FOUND');
      }
      joinLimiter.reset(ip); // succès : on oublie les échecs de cette IP
      enterRoom(socket, res.room, res.member);
      // Remplacement d'un indicatif déconnecté : signaler le départ du fantôme.
      if (res.replacedMemberId) {
        socket.to(res.room.code).emit('member_left', { memberId: res.replacedMemberId, reason: 'left' });
      }
      socket.to(res.room.code).emit('member_joined', { member: manager.memberPublic(res.member) });
      ack({
        ok: true,
        roomCode: res.room.code,
        memberId: res.member.id,
        sessionToken: res.member.sessionToken,
        roomState: manager.roomState(res.room),
      });
    });

    socket.on('rejoin_room', (p, ack) => {
      if (typeof ack !== 'function') return;
      if (!p || typeof p.roomCode !== 'string' || typeof p.memberId !== 'string' || typeof p.sessionToken !== 'string') {
        return fail(ack, 'INVALID_PAYLOAD');
      }
      const res = manager.rejoin(p.roomCode, p.memberId, p.sessionToken, socket.id);
      if (isErr(res)) return fail(ack, res.error, true);
      enterRoom(socket, res.room, res.member);
      socket.to(res.room.code).emit('member_updated', { memberId: res.member.id, connected: true });
      ack({ ok: true, roomState: manager.roomState(res.room) });
    });

    socket.on('position_update', (p) => {
      const ctx = currentMember();
      if (!ctx || !isValidPosition(p)) return;
      if (!manager.acceptPosition(ctx.member, p)) return;
      socket.to(ctx.room.code).emit('member_position', { memberId: ctx.member.id, position: p });
    });

    socket.on('update_symbol', (p) => {
      const ctx = currentMember();
      if (!ctx || !p || !isValidRole(p.role)) return;
      // Unicité des postes : rejet silencieux si le poste visé est déjà tenu par
      // un autre membre (best-effort — l'accusé n'est pas prévu par le protocole).
      if (p.role !== 'GV') {
        const taken = [...ctx.room.members.values()].some(
          (m) => m.id !== ctx.member.id && m.role === p.role,
        );
        if (taken) return;
      }
      ctx.member.role = p.role;
      socket.to(ctx.room.code).emit('member_updated', { memberId: ctx.member.id, role: p.role });
    });

    socket.on('send_order', (order, ack) => {
      const ctx = currentMember();
      if (!ctx) return fail(ack, 'NOT_IN_ROOM');
      if (!isValidOrder(order, ctx.member.id)) return fail(ack, 'INVALID_PAYLOAD');
      // Anti-flood : au-delà du quota, on refuse sans diffuser. RATE_LIMITED est
      // transitoire côté client (l'ordre reste en file et sera retenté), donc un
      // dessin légitime brièvement au-dessus du seuil n'est pas perdu.
      if (!manager.acceptOrder(ctx.member)) return fail(ack, 'RATE_LIMITED');
      manager.pushOrder(ctx.room, order);
      socket.to(ctx.room.code).emit('order', order);
      ack({ ok: true });
    });

    socket.on('leave_room', () => {
      const ctx = currentMember();
      if (!ctx) return;
      void socket.leave(ctx.room.code);
      manager.leave(ctx.room.code, ctx.member.id);
      socket.to(ctx.room.code).emit('member_left', { memberId: ctx.member.id, reason: 'left' });
      socket.data.roomCode = undefined;
      socket.data.memberId = undefined;
    });

    socket.on('disconnect', () => {
      const { roomCode, memberId } = socket.data;
      if (!roomCode || !memberId) return;
      const member = manager.markDisconnected(roomCode, memberId);
      // Ignorer si un autre socket a déjà re-bindé ce membre (reload rapide).
      if (member && member.socketId === null) {
        io.to(roomCode).emit('member_updated', { memberId, connected: false });
      }
    });
  });

  const gcTimer = setInterval(() => {
    const events = manager.sweep();
    for (const { roomCode, memberId } of events.memberTimeouts) {
      io.to(roomCode).emit('member_left', { memberId, reason: 'timeout' });
    }
    for (const roomCode of events.closedRooms) {
      io.to(roomCode).emit('room_closed', { reason: 'expired' });
      void io.in(roomCode).socketsLeave(roomCode);
    }
  }, GC_INTERVAL_MS);

  return () => clearInterval(gcTimer);
}

function isValidOrder(o: unknown, authorId: string): o is OrderMessage {
  if (typeof o !== 'object' || o === null) return false;
  const m = o as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.authorId !== authorId || !isFiniteNum(m.ts)) return false;
  if (typeof m.kind !== 'string' || typeof m.payload !== 'object' || m.payload === null) return false;
  try {
    // Le serveur n'interprète pas le payload, il borne juste sa taille.
    return JSON.stringify(o).length <= MAX_ORDER_BYTES;
  } catch {
    return false;
  }
}
