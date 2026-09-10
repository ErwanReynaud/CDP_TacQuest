// OR-Set add-wins : fusion, masquage, compaction, convergence.

import { describe, expect, it } from 'vitest';
import type { OrderMessage } from '@tq/shared/protocol';
import { TOMBSTONE_TTL_MS } from '@tq/shared/mesh/constants';
import { visibleGraphics, visibleWaypoints } from '../map/orderFilter';
import { compactOrders, isHidden, mergeOrder, type OrderStore, suppression } from './orders';

const T0 = 1_767_225_600_000; // 2026-01-01T00:00:00Z

const wp = (id: string, ts: number, name = 'ENI'): OrderMessage => ({
  id,
  authorId: 'a1',
  ts,
  kind: 'waypoint',
  payload: { kind: 'waypoint', name, lat: 45.1, lng: 5.7, sidc: 'SHGP-------' },
});

const gfx = (id: string, ts: number): OrderMessage => ({
  id,
  authorId: 'a1',
  ts,
  kind: 'graphic',
  payload: {
    kind: 'graphic',
    geojson: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[5.7, 45.1], [5.8, 45.2]] },
    },
    style: { color: '#e8d44d' },
  },
});

const rm = (id: string, ts: number, target: string): OrderMessage => ({
  id, authorId: 'a1', ts, kind: 'remove', payload: { kind: 'remove', orderId: target },
});

const clear = (id: string, ts: number, beforeTs: number): OrderMessage => ({
  id, authorId: 'a1', ts, kind: 'clear', payload: { kind: 'clear', beforeTs },
});

const store = (...orders: OrderMessage[]): OrderStore =>
  new Map(orders.map((o) => [o.id, o]));

describe('mergeOrder', () => {
  it('accepte un ordre inconnu', () => {
    const s: OrderStore = new Map();
    expect(mergeOrder(s, wp('w1', T0))).toBe(true);
    expect(s.size).toBe(1);
  });

  it('est idempotent : une réémission ne change rien', () => {
    const s = store(wp('w1', T0));
    expect(mergeOrder(s, wp('w1', T0))).toBe(false);
  });

  it('accepte une édition plus récente du même identifiant', () => {
    const s = store(wp('w1', T0, 'ENI'));
    expect(mergeOrder(s, wp('w1', T0 + 1000, 'ENI corrigé'))).toBe(true);
    expect((s.get('w1')!.payload as { name: string }).name).toBe('ENI corrigé');
  });

  it('ignore une trame retardée porteuse d’une version périmée', () => {
    // Sans cette garde, un relais lent ressusciterait un plot déjà corrigé.
    const s = store(wp('w1', T0 + 1000, 'à jour'));
    expect(mergeOrder(s, wp('w1', T0, 'périmé'))).toBe(false);
    expect((s.get('w1')!.payload as { name: string }).name).toBe('à jour');
  });
});

describe('masquage add-wins', () => {
  it('masque un plot visé par une suppression postérieure', () => {
    const s = store(wp('w1', T0), rm('r1', T0 + 1000, 'w1'));
    expect(visibleWaypoints(s)).toHaveLength(0);
  });

  it('fait réapparaître un plot corrigé après sa suppression', () => {
    // Le cœur de l'arbitrage : en remove-wins, cette correction fraîche d'un
    // plot ENI disparaîtrait silencieusement.
    const s = store(rm('r1', T0 + 1000, 'w1'), wp('w1', T0 + 2000, 'ENI confirmé'));
    const out = visibleWaypoints(s);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('ENI confirmé');
  });

  it('fait gagner la suppression à horodatage égal', () => {
    const s = store(wp('w1', T0), rm('r1', T0, 'w1'));
    expect(visibleWaypoints(s)).toHaveLength(0);
  });

  it('ne masque rien avec une suppression antérieure à la création', () => {
    const s = store(rm('r1', T0, 'w1'), wp('w1', T0 + 1));
    expect(visibleWaypoints(s)).toHaveLength(1);
  });
});

describe('clear', () => {
  it('masque tout ce qui lui est antérieur, graphiques et plots', () => {
    const s = store(wp('w1', T0), gfx('g1', T0 + 500), clear('c1', T0 + 1000, T0 + 1000));
    expect(visibleWaypoints(s)).toHaveLength(0);
    expect(visibleGraphics(s)).toHaveLength(0);
  });

  it('n’avale pas un ordre postérieur', () => {
    const s = store(
      wp('w1', T0),
      clear('c1', T0 + 1000, T0 + 1000),
      wp('w2', T0 + 2000, 'après effacement'),
    );
    expect(visibleWaypoints(s).map((w) => w.id)).toEqual(['w2']);
  });

  it('retient le seuil le plus récent quand plusieurs clear coexistent', () => {
    const s = store(
      wp('w1', T0), wp('w2', T0 + 1500),
      clear('c1', T0 + 1000, T0 + 1000),
      clear('c2', T0 + 2000, T0 + 2000),
    );
    expect(suppression(s).clearedBefore).toBe(T0 + 2000);
    expect(visibleWaypoints(s)).toHaveLength(0);
  });

  it('remplace N suppressions par une seule entrée', () => {
    // clearWholeMap() émettait un remove par figuré : 40 paquets LoRa.
    const many = Array.from({ length: 40 }, (_, i) => wp(`w${i}`, T0 + i));
    const s = store(...many, clear('c1', T0 + 100, T0 + 100));
    expect(visibleWaypoints(s)).toHaveLength(0);
    expect([...s.values()].filter((o) => o.payload.kind === 'clear')).toHaveLength(1);
  });
});

describe('compaction', () => {
  const OLD = T0 - TOMBSTONE_TTL_MS - 1000;

  it('purge un tombstone expiré et sa cible ensemble', () => {
    // Retirer le tombstone seul ferait réapparaître la cible chez ce nœud
    // alors qu'elle reste effacée chez les autres.
    const s = store(wp('w1', OLD), rm('r1', OLD + 10, 'w1'));
    compactOrders(s, T0);
    expect(s.has('w1')).toBe(false);
    expect(s.has('r1')).toBe(false);
  });

  it('conserve une cible encore protégée par un tombstone valide', () => {
    const s = store(wp('w1', OLD), rm('r1', T0 - 1000, 'w1'));
    compactOrders(s, T0);
    expect(s.has('r1')).toBe(true);
    expect(s.has('w1')).toBe(true);
    expect(visibleWaypoints(s)).toHaveLength(0);
  });

  it('ne touche pas aux figurés vivants, même anciens', () => {
    const s = store(wp('w1', OLD), gfx('g1', OLD));
    compactOrders(s, T0);
    expect(s.size).toBe(2);
    expect(visibleWaypoints(s)).toHaveLength(1);
  });

  it('purge les messages et accusés expirés, qui font le volume', () => {
    const s = store(
      { id: 't1', authorId: 'a1', ts: OLD, kind: 'text', payload: { kind: 'text', body: 'vieux' } },
      { id: 'k1', authorId: 'a1', ts: OLD, kind: 'ack', payload: { kind: 'ack', orderId: 'w1' } },
      { id: 't2', authorId: 'a1', ts: T0, kind: 'text', payload: { kind: 'text', body: 'récent' } },
    );
    compactOrders(s, T0);
    expect([...s.keys()]).toEqual(['t2']);
  });

  it('purge un clear expiré avec tout ce qu’il masquait', () => {
    const s = store(wp('w1', OLD), gfx('g1', OLD), clear('c1', OLD + 10, OLD + 10));
    compactOrders(s, T0);
    expect(s.size).toBe(0);
  });
});

describe('convergence', () => {
  /** Applique les mêmes ordres dans des ordres d'arrivée différents. */
  function converge(orders: OrderMessage[]): string[][] {
    const permutations = [
      orders,
      [...orders].reverse(),
      // Ordre d'arrivée mélangé, mais déterministe pour un test reproductible.
      [...orders].sort((a, b) => a.id.localeCompare(b.id)),
    ];
    return permutations.map((seq) => {
      const s: OrderStore = new Map();
      for (const o of seq) mergeOrder(s, o);
      return visibleWaypoints(s).map((w) => w.id).sort();
    });
  }

  it('donne le même résultat quel que soit l’ordre d’arrivée', () => {
    const orders = [
      wp('w1', T0), wp('w2', T0 + 100), wp('w3', T0 + 200),
      rm('r1', T0 + 300, 'w2'),
      wp('w1', T0 + 400, 'w1 corrigé'),
      rm('r2', T0 + 500, 'w3'),
    ];
    const [a, b, c] = converge(orders);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toEqual(['w1']);
  });

  it('converge aussi après une réparation de partition', () => {
    // Deux groupes hors portée composent chacun de leur côté, puis se
    // retrouvent : les deux magasins doivent finir identiques.
    const groupeA = [wp('a1', T0), gfx('a2', T0 + 100)];
    const groupeB = [wp('b1', T0 + 50), rm('b2', T0 + 150, 'a1')];

    const nord: OrderStore = new Map();
    const sud: OrderStore = new Map();
    for (const o of groupeA) mergeOrder(nord, o);
    for (const o of groupeB) mergeOrder(sud, o);
    // Contact rétabli : chacun reçoit ce qui lui manquait.
    for (const o of groupeB) mergeOrder(nord, o);
    for (const o of groupeA) mergeOrder(sud, o);

    expect(visibleWaypoints(nord).map((w) => w.id)).toEqual(visibleWaypoints(sud).map((w) => w.id));
    expect(visibleGraphics(nord).map((g) => g.id)).toEqual(visibleGraphics(sud).map((g) => g.id));
    expect(visibleWaypoints(nord).map((w) => w.id)).toEqual(['b1']);
  });

  it('isHidden est une fonction pure de l’état, sans effet d’ordre', () => {
    const s = store(wp('w1', T0), rm('r1', T0 + 1, 'w1'));
    const sup = suppression(s);
    const first = isHidden(s.get('w1')!, sup);
    expect(isHidden(s.get('w1')!, sup)).toBe(first);
    expect(first).toBe(true);
  });
});
