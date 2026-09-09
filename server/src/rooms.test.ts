import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_GRACE_MS,
  ORDER_MAX_PER_WINDOW,
  ORDER_WINDOW_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_EMPTY_TTL_MS,
} from '@tq/shared/constants';
import { isErr, RoomManager } from './rooms';

// Rôle par défaut des helpers : GV, non contraint par l'unicité des postes, pour
// que plusieurs membres puissent coexister sans conflit dans les tests génériques.
const ROLE = 'GV';
const T0 = 1_000_000;

function createdRoom(manager: RoomManager, now = T0) {
  const res = manager.createRoom('Alpha 1', ROLE, 'sock-leader', now);
  if (isErr(res)) throw new Error(res.error);
  return res;
}

describe('génération des codes', () => {
  it('produit des codes de longueur ROOM_CODE_LENGTH dans l’alphabet radio', () => {
    const manager = new RoomManager();
    for (let i = 0; i < 50; i++) {
      const { room } = createdRoom(manager);
      expect(room.code).toHaveLength(ROOM_CODE_LENGTH);
      for (const ch of room.code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
    expect(manager.rooms.size).toBe(50);
  });
});

describe('join', () => {
  it('rejette un code inconnu', () => {
    const manager = new RoomManager();
    const res = manager.joinRoom('ZZZZZZ', 'Bravo 2', ROLE, 's2', T0);
    expect(res).toEqual({ ok: false, error: 'ROOM_NOT_FOUND' });
  });

  it('rejette un indicatif tenu par un membre connecté', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const res = manager.joinRoom(room.code, 'alpha 1', ROLE, 's2', T0);
    expect(res).toEqual({ ok: false, error: 'CALLSIGN_TAKEN' });
  });

  it('signale (sans remplacer) un indicatif tenu par un membre déconnecté', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.markDisconnected(room.code, member.id, T0 + 1000);
    const res = manager.joinRoom(room.code, 'alpha 1', ROLE, 's2', T0 + 2000);
    expect(res).toEqual({ ok: false, error: 'CALLSIGN_TAKEN_DISCONNECTED' });
    expect(room.members.size).toBe(1); // le fantôme n'est pas touché
  });

  it('remplace un indicatif déconnecté quand replace=true (évince le fantôme)', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.markDisconnected(room.code, member.id, T0 + 1000);
    const res = manager.joinRoom(room.code, 'Alpha 1', ROLE, 's2', T0 + 2000, true);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.replacedMemberId).toBe(member.id);
      expect(res.member.id).not.toBe(member.id);
      expect(res.member.connected).toBe(true);
    }
    expect(room.members.size).toBe(1); // l'ancien évincé, le nouveau à sa place
    expect(room.members.has(member.id)).toBe(false);
  });

  it('le créateur est chef, les suivants non', () => {
    const manager = new RoomManager();
    const { room, member: leader } = createdRoom(manager);
    const res = manager.joinRoom(room.code, 'Bravo 2', ROLE, 's2', T0);
    expect(res.ok).toBe(true);
    expect(leader.isLeader).toBe(true);
    if (res.ok) expect(res.member.isLeader).toBe(false);
  });
});

describe('unicité des postes', () => {
  function roomWith(role: string) {
    const manager = new RoomManager();
    const res = manager.createRoom('Alpha 1', role, 'sock-leader', T0);
    if (isErr(res)) throw new Error(res.error);
    return { manager, ...res };
  }

  it('rejette un poste de commandement tenu par un membre connecté', () => {
    const { manager, room } = roomWith('CDS:2');
    const res = manager.joinRoom(room.code, 'Bravo 2', 'CDS:2', 's2', T0);
    expect(res).toEqual({ ok: false, error: 'POST_TAKEN' });
  });

  it('signale (sans remplacer) un poste tenu par un membre déconnecté', () => {
    const { manager, room, member } = roomWith('CDE:2:2:A');
    manager.markDisconnected(room.code, member.id, T0 + 1000);
    const res = manager.joinRoom(room.code, 'Bravo 2', 'CDE:2:2:A', 's2', T0 + 2000);
    expect(res).toEqual({ ok: false, error: 'POST_TAKEN_DISCONNECTED' });
    expect(room.members.size).toBe(1);
  });

  it('remplace un poste déconnecté quand replace=true (évince le fantôme)', () => {
    const { manager, room, member } = roomWith('CDG:1:3');
    manager.markDisconnected(room.code, member.id, T0 + 1000);
    const res = manager.joinRoom(room.code, 'Bravo 2', 'CDG:1:3', 's2', T0 + 2000, true);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.replacedMemberId).toBe(member.id);
    expect(room.members.size).toBe(1);
    expect(room.members.has(member.id)).toBe(false);
  });

  it('autorise plusieurs GV (poste non contraint)', () => {
    const { manager, room } = roomWith('GV');
    const res = manager.joinRoom(room.code, 'Bravo 2', 'GV', 's2', T0);
    expect(res.ok).toBe(true);
    expect(room.members.size).toBe(2);
  });

  it('n’oppose pas les postes distincts', () => {
    const { manager, room } = roomWith('CDS:1');
    const res = manager.joinRoom(room.code, 'Bravo 2', 'CDS:2', 's2', T0);
    expect(res.ok).toBe(true);
  });
});

describe('rejoin et période de grâce', () => {
  it('re-binde avec le bon sessionToken, rejette le mauvais', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.markDisconnected(room.code, member.id, T0 + 1000);
    expect(member.connected).toBe(false);

    const bad = manager.rejoin(room.code, member.id, 'faux-token', 's2', T0 + 2000);
    expect(bad).toEqual({ ok: false, error: 'SESSION_INVALID' });

    const good = manager.rejoin(room.code, member.id, member.sessionToken, 's2', T0 + 2000);
    expect(good.ok).toBe(true);
    expect(member.connected).toBe(true);
    expect(member.socketId).toBe('s2');
  });

  it('supprime le membre après expiration de la grâce', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const joined = manager.joinRoom(room.code, 'Bravo 2', ROLE, 's2', T0);
    if (!joined.ok) throw new Error('join failed');
    manager.markDisconnected(room.code, joined.member.id, T0);

    expect(manager.sweep(T0 + DISCONNECT_GRACE_MS - 1).memberTimeouts).toHaveLength(0);
    const events = manager.sweep(T0 + DISCONNECT_GRACE_MS + 1);
    expect(events.memberTimeouts).toEqual([{ roomCode: room.code, memberId: joined.member.id }]);
    expect(room.members.has(joined.member.id)).toBe(false);
  });
});

describe('GC des rooms', () => {
  it('supprime une room vide depuis plus de ROOM_EMPTY_TTL_MS', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.leave(room.code, member.id, T0);
    expect(manager.sweep(T0 + ROOM_EMPTY_TTL_MS - 1).closedRooms).toHaveLength(0);
    expect(manager.sweep(T0 + ROOM_EMPTY_TTL_MS + 1).closedRooms).toEqual([room.code]);
    expect(manager.rooms.size).toBe(0);
  });

  it('on peut encore rejoindre une room vide avant le TTL', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.leave(room.code, member.id, T0);
    const res = manager.joinRoom(room.code, 'Bravo 2', ROLE, 's2', T0 + 60_000);
    expect(res.ok).toBe(true);
    expect(room.emptySince).toBeNull();
  });

  it('TTL glissant : une room occupée ne meurt jamais, quel que soit son âge', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    // Bien au-delà de 24 h : le membre est toujours connecté → room conservée.
    expect(manager.sweep(T0 + 3 * ROOM_EMPTY_TTL_MS).closedRooms).toHaveLength(0);
    expect(manager.rooms.has(room.code)).toBe(true);
  });

  it('TTL glissant : le compte à rebours part de la dernière déconnexion', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    // Room vieille de 2×TTL quand son dernier membre se déconnecte…
    const t1 = T0 + 2 * ROOM_EMPTY_TTL_MS;
    manager.markDisconnected(room.code, member.id, t1);
    // …elle survit encore presque 24 h, puis meurt (le membre part en même
    // temps : sa grâce, elle aussi de 24 h, expire au même balayage).
    expect(manager.sweep(t1 + ROOM_EMPTY_TTL_MS - 1).closedRooms).toHaveLength(0);
    expect(manager.sweep(t1 + ROOM_EMPTY_TTL_MS + 1).closedRooms).toEqual([room.code]);
  });
});

describe('throttle des positions', () => {
  it('rejette les fixes trop rapprochés et garde le dernier accepté', () => {
    const manager = new RoomManager();
    const { member } = createdRoom(manager);
    const fix = (ts: number) => ({ lat: 45, lng: 5, accuracy: 10, heading: null, speed: null, ts });

    expect(manager.acceptPosition(member, fix(T0), T0)).toBe(true);
    expect(manager.acceptPosition(member, fix(T0 + 500), T0 + 500)).toBe(false);
    expect(manager.acceptPosition(member, fix(T0 + 1000), T0 + 1000)).toBe(true);
    expect(member.lastPosition?.ts).toBe(T0 + 1000);
  });
});

describe('administration', () => {
  it('closeRoom supprime la room et signale l’absence', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    expect(manager.closeRoom(room.code)).toBe(true);
    expect(manager.rooms.has(room.code)).toBe(false);
    expect(manager.closeRoom(room.code)).toBe(false);
  });

  it('extendRoom est sans effet sur une room occupée (elle n’expire pas)', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const later = T0 + 1000;
    expect(manager.extendRoom(room.code, later)).toBe(true);
    // Occupée par un membre connecté → pas en compte à rebours "vide".
    expect(room.emptySince).toBeNull();
    expect(manager.extendRoom('ZZZZZ', later)).toBe(false);
  });

  it('extendRoom redémarre le compte à rebours "vide" si la room est vide', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    manager.markDisconnected(room.code, member.id, T0);
    const later = T0 + 10_000;
    manager.extendRoom(room.code, later);
    expect(room.emptySince).toBe(later);
  });

  it('kickMember retire le membre et renvoie son socketId', () => {
    const manager = new RoomManager();
    const { room } = createdRoom(manager);
    const joined = manager.joinRoom(room.code, 'Bravo 2', ROLE, 'sock-b2', T0);
    if (isErr(joined)) throw new Error(joined.error);
    const removed = manager.kickMember(room.code, joined.member.id);
    expect(removed?.socketId).toBe('sock-b2');
    expect(room.members.has(joined.member.id)).toBe(false);
    expect(manager.kickMember(room.code, joined.member.id)).toBeNull();
  });

  it('summarize expose les rooms, l’effectif connecté et l’expiration', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    const joined = manager.joinRoom(room.code, 'Bravo 2', ROLE, 'sock-b2', T0);
    if (isErr(joined)) throw new Error(joined.error);
    manager.markDisconnected(room.code, joined.member.id, T0);
    const summary = manager.summarize(T0)[0]!;
    expect(summary.code).toBe(room.code);
    expect(summary.memberCount).toBe(2);
    expect(summary.connectedCount).toBe(1);
    // TTL glissant : un membre encore connecté → aucune échéance.
    expect(summary.expiresAt).toBeNull();
    // Le chef remonte en tête de liste.
    expect(summary.members[0]!.id).toBe(member.id);
    expect(summary.members[0]!.isLeader).toBe(true);
  });
});

describe('acceptOrder (throttle anti-flood)', () => {
  it('accepte jusqu’à ORDER_MAX_PER_WINDOW puis rejette dans la fenêtre', () => {
    const manager = new RoomManager();
    const { member } = createdRoom(manager);
    for (let i = 0; i < ORDER_MAX_PER_WINDOW; i++) {
      expect(manager.acceptOrder(member, T0)).toBe(true);
    }
    expect(manager.acceptOrder(member, T0)).toBe(false);
  });

  it('réinitialise le compteur à la fenêtre suivante', () => {
    const manager = new RoomManager();
    const { member } = createdRoom(manager);
    for (let i = 0; i < ORDER_MAX_PER_WINDOW; i++) manager.acceptOrder(member, T0);
    expect(manager.acceptOrder(member, T0)).toBe(false);
    expect(manager.acceptOrder(member, T0 + ORDER_WINDOW_MS)).toBe(true);
  });

  it('isole le quota entre membres', () => {
    const manager = new RoomManager();
    const { room, member } = createdRoom(manager);
    const second = manager.joinRoom(room.code, 'Bravo 2', ROLE, 'sock-2', T0);
    if (isErr(second)) throw new Error(second.error);
    for (let i = 0; i < ORDER_MAX_PER_WINDOW; i++) manager.acceptOrder(member, T0);
    expect(manager.acceptOrder(member, T0)).toBe(false);
    expect(manager.acceptOrder(second.member, T0)).toBe(true);
  });

  it('tolère un membre restauré sans champs de throttle (ancien snapshot)', () => {
    const manager = new RoomManager();
    const { member } = createdRoom(manager);
    // Simule un snapshot antérieur au throttle : champs absents.
    delete (member as { orderWindowStart?: number }).orderWindowStart;
    delete (member as { ordersInWindow?: number }).ordersInWindow;
    expect(manager.acceptOrder(member, T0)).toBe(true);
  });
});
