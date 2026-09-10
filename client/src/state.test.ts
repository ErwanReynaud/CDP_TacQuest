// Corrections d'audit sur l'état partagé : bus, session, snapshot serveur.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberPublic, OrderMessage, Position, RoomState } from '@tq/shared/protocol';

/** localStorage simulé ; `fail` le fait lever, comme un quota dépassé. */
function stubStorage(fail = false): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (fail) throw new DOMException('QuotaExceededError');
      store.set(k, v);
    },
    removeItem: (k: string) => store.delete(k),
  });
  return store;
}

/** Import frais : state.ts porte de l'état de module. */
async function freshState(fail = false) {
  vi.resetModules();
  stubStorage(fail);
  return await import('./state');
}

afterEach(() => vi.unstubAllGlobals());

describe('bus — isolation des écouteurs (A3)', () => {
  let mod: Awaited<ReturnType<typeof freshState>>;
  beforeEach(async () => {
    mod = await freshState();
  });

  it('exécute les écouteurs suivants malgré une exception', () => {
    // Sans cloisonnement, un paquet radio malformé atteignant un écouteur
    // d'interface coupait toute la chaîne de réception.
    const seen: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mod.bus.on('orders', () => seen.push('avant'));
    mod.bus.on('orders', () => {
      throw new Error('écouteur cassé');
    });
    mod.bus.on('orders', () => seen.push('après'));

    expect(() => mod.bus.emit('orders')).not.toThrow();
    expect(seen).toEqual(['avant', 'après']);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('ne laisse pas l’exception remonter dans l’émetteur', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mod.bus.on('conn', () => {
      throw new Error('boum');
    });
    expect(() => mod.setConn('offline')).not.toThrow();
    err.mockRestore();
  });

  it('transmet le détail à chaque écouteur', () => {
    const seen: unknown[] = [];
    mod.bus.on('position', (d) => seen.push(d));
    mod.bus.on('position', (d) => seen.push(d));
    mod.bus.emit('position', 'm1');
    expect(seen).toEqual(['m1', 'm1']);
  });

  it('se désabonne par la fonction rendue', () => {
    let n = 0;
    const off = mod.bus.on('orders', () => n++);
    mod.bus.emit('orders');
    off();
    mod.bus.emit('orders');
    expect(n).toBe(1);
  });

  it('se désabonne aussi par off()', () => {
    let n = 0;
    const fn = (): void => {
      n++;
    };
    mod.bus.on('orders', fn);
    mod.bus.off('orders', fn);
    mod.bus.emit('orders');
    expect(n).toBe(0);
  });

  it('tolère un abonnement pendant la diffusion', () => {
    // L'itération porte sur une copie : le nouvel écouteur ne doit pas être
    // appelé pour l'événement en cours, ni boucler indéfiniment.
    let inner = 0;
    mod.bus.on('orders', () => {
      mod.bus.on('orders', () => inner++);
    });
    expect(() => mod.bus.emit('orders')).not.toThrow();
    expect(inner).toBe(0);
  });
});

describe('saveSession — la persistance ne bloque pas l’entrée (A2)', () => {
  const session = {
    roomCode: 'ABCDE',
    memberId: 'm1',
    sessionToken: 't',
    callsign: 'ALPHA',
    role: 'GV',
    isLeader: true,
  };

  it('renvoie true et persiste quand le stockage marche', async () => {
    const mod = await freshState();
    expect(mod.saveSession(session)).toBe(true);
    expect(mod.state.session?.roomCode).toBe('ABCDE');
    expect(mod.loadLastRoom()?.callsign).toBe('ALPHA');
  });

  it('renvoie false sans lever quand le stockage refuse', async () => {
    // Quota dépassé ou navigation privée : l'écriture levait après avoir muté
    // state.session, et l'appelant rapportait « Serveur injoignable ».
    const mod = await freshState(true);
    expect(() => mod.saveSession(session)).not.toThrow();
    expect(mod.saveSession(session)).toBe(false);
  });

  it('garde la session utilisable en mémoire malgré l’échec', async () => {
    const mod = await freshState(true);
    mod.saveSession(session);
    expect(mod.state.session?.memberId).toBe('m1');
  });

  it('remet la connexion à zéro en quittant la salle', async () => {
    const mod = await freshState();
    mod.saveSession(session);
    mod.setConn('connected');
    mod.clearSession();
    // La pastille restait « Connecté » une fois revenu en solo.
    expect(mod.state.conn).toBe('reconnecting');
    expect(mod.state.session).toBeNull();
  });
});

describe('applyRoomState — fusion et non remplacement (A1)', () => {
  const member = (id: string, lastPosition: Position | null = null): MemberPublic => ({
    id, callsign: id.toUpperCase(), role: 'GV', isLeader: false,
    connected: true, lastSeen: 1, lastPosition,
  });
  const wp = (id: string, ts: number): OrderMessage => ({
    id, authorId: 'm2', ts, kind: 'waypoint',
    payload: { kind: 'waypoint', name: id, lat: 45, lng: 5 },
  });
  const snapshot = (code: string, orders: OrderMessage[], members: MemberPublic[] = []): RoomState =>
    ({ code, members, recentOrders: orders });

  const session = {
    roomCode: 'ABCDE', memberId: 'm1', sessionToken: 't',
    callsign: 'ALPHA', role: 'GV', isLeader: true,
  };

  it('conserve un figuré tombé du tampon serveur', async () => {
    // MAX_RECENT_ORDERS évince les plus anciens. Un remplacement effaçait chez
    // le client qui se reconnecte des figurés que les autres voyaient encore.
    const mod = await freshState();
    mod.saveSession(session);
    mod.state.orders.set('ancien', wp('ancien', 10));
    mod.applyRoomState(snapshot('ABCDE', [wp('recent', 20)]));
    expect([...mod.state.orders.keys()].sort()).toEqual(['ancien', 'recent']);
  });

  it('retient la version la plus récente d’un ordre réédité', async () => {
    const mod = await freshState();
    mod.saveSession(session);
    mod.state.orders.set('w1', wp('w1', 10));
    mod.applyRoomState(snapshot('ABCDE', [wp('w1', 20)]));
    expect(mod.state.orders.get('w1')!.ts).toBe(20);
  });

  it('ignore un ordre plus ancien que celui détenu', async () => {
    const mod = await freshState();
    mod.saveSession(session);
    mod.state.orders.set('w1', wp('w1', 30));
    mod.applyRoomState(snapshot('ABCDE', [wp('w1', 10)]));
    expect(mod.state.orders.get('w1')!.ts).toBe(30);
  });

  it('remplace en changeant de salle', async () => {
    // Sans quoi les figurés de la salle précédente se déverseraient dans la
    // nouvelle. Le code de salle distingue reconnexion et changement.
    const mod = await freshState();
    mod.saveSession(session);
    mod.state.orders.set('vieux', wp('vieux', 10));
    mod.applyRoomState(snapshot('ZZZZZ', [wp('neuf', 20)]));
    expect([...mod.state.orders.keys()]).toEqual(['neuf']);
  });

  it('remplace le roster, source de vérité serveur', async () => {
    const mod = await freshState();
    mod.saveSession(session);
    mod.state.members.set('parti', member('parti'));
    mod.applyRoomState(snapshot('ABCDE', [], [member('m2')]));
    expect([...mod.state.members.keys()]).toEqual(['m2']);
  });

  it('préserve notre propre position, que le serveur n’écho pas', async () => {
    // Sans ce report, on disparaissait du compteur et du tiroir jusqu'au fix
    // suivant, soit 30 s.
    const mod = await freshState();
    mod.saveSession(session);
    const fix: Position = { lat: 45.1, lng: 5.1, accuracy: 5, heading: null, speed: null, ts: 99 };
    mod.state.members.set('m1', member('m1', fix));
    mod.applyRoomState(snapshot('ABCDE', [], [member('m1'), member('m2')]));
    expect(mod.state.members.get('m1')!.lastPosition).toEqual(fix);
  });

  it('laisse le serveur gagner s’il connaît notre position', async () => {
    const mod = await freshState();
    mod.saveSession(session);
    const local: Position = { lat: 45.1, lng: 5.1, accuracy: 5, heading: null, speed: null, ts: 1 };
    const remote: Position = { lat: 46.2, lng: 6.2, accuracy: 5, heading: null, speed: null, ts: 2 };
    mod.state.members.set('m1', member('m1', local));
    mod.applyRoomState(snapshot('ABCDE', [], [member('m1', remote)]));
    expect(mod.state.members.get('m1')!.lastPosition).toEqual(remote);
  });
});
