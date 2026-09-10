// Persistance locale des ordres reçus par la radio.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderMessage } from '@tq/shared/protocol';
import { TOMBSTONE_TTL_MS } from '@tq/shared/mesh/constants';
import type { OrderStore } from '../crdt/orders';
import {
  clearMeshOrders,
  flushMeshSave,
  loadMeshOrders,
  saveMeshOrders,
  scheduleMeshSave,
} from './meshStore';

const T0 = 1_767_225_600_000;

const wp = (id: string, ts = T0): OrderMessage => ({
  id, authorId: 'a1', ts, kind: 'waypoint',
  payload: { kind: 'waypoint', name: id, lat: 45, lng: 5 },
});

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

const store = (...orders: OrderMessage[]): OrderStore => new Map(orders.map((o) => [o.id, o]));

beforeEach(() => {
  vi.useFakeTimers();
  stubStorage();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('aller-retour', () => {
  it('relit ce qui a été écrit', () => {
    saveMeshOrders(store(wp('a4f2c810:0001'), wp('a4f2c810:0002')), T0);
    expect(loadMeshOrders().map((o) => o.id).sort()).toEqual(['a4f2c810:0001', 'a4f2c810:0002']);
  });

  it('renvoie une liste vide quand rien n’est stocké', () => {
    expect(loadMeshOrders()).toEqual([]);
  });

  it('efface l’entrée quand il ne reste plus rien', () => {
    saveMeshOrders(store(wp('a4f2c810:0001')), T0);
    saveMeshOrders(new Map(), T0);
    expect(loadMeshOrders()).toEqual([]);
  });
});

describe('robustesse des données relues', () => {
  it('ignore un contenu illisible', () => {
    // localStorage est modifiable par l'utilisateur et survit aux changements
    // de version : une entrée douteuse ne doit pas contaminer l'état.
    localStorage.setItem('tq-mesh-orders', '{ pas du json');
    expect(loadMeshOrders()).toEqual([]);
  });

  it('ignore un contenu qui n’est pas un tableau', () => {
    localStorage.setItem('tq-mesh-orders', '{"id":"x"}');
    expect(loadMeshOrders()).toEqual([]);
  });

  it('écarte les entrées mal formées mais garde les bonnes', () => {
    localStorage.setItem(
      'tq-mesh-orders',
      JSON.stringify([wp('a4f2c810:0001'), { id: 'incomplet' }, null, 42]),
    );
    expect(loadMeshOrders().map((o) => o.id)).toEqual(['a4f2c810:0001']);
  });

  it('ne lève pas quand le stockage refuse d’écrire', () => {
    vi.unstubAllGlobals();
    stubStorage(true);
    expect(() => saveMeshOrders(store(wp('a4f2c810:0001')), T0)).not.toThrow();
  });
});

describe('compaction et plafond', () => {
  it('ne persiste pas les tombstones expirés', () => {
    const old = T0 - TOMBSTONE_TTL_MS - 1000;
    const s = store(wp('a4f2c810:0001', old), {
      id: 'a4f2c810:0002', authorId: 'a1', ts: old + 10, kind: 'remove',
      payload: { kind: 'remove', orderId: 'a4f2c810:0001' },
    });
    saveMeshOrders(s, T0);
    expect(loadMeshOrders()).toEqual([]);
  });

  it('garde les plus récents au-delà du plafond', () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      wp(`a4f2c810:${i.toString(16).padStart(4, '0')}`, T0 + i),
    );
    saveMeshOrders(store(...many), T0 + 600);
    const kept = loadMeshOrders();
    expect(kept).toHaveLength(500);
    // Les 100 plus anciens sont sacrifiés, pas les récents.
    expect(kept.some((o) => o.ts === T0)).toBe(false);
    expect(kept.some((o) => o.ts === T0 + 599)).toBe(true);
  });
});

describe('écriture différée', () => {
  it('fond une rafale en une seule écriture', () => {
    // Un rattrapage d'anti-entropie fait entrer des dizaines d'ordres d'affilée.
    const s = store();
    const spy = vi.spyOn(localStorage, 'setItem');
    for (let i = 0; i < 20; i++) {
      s.set(`a4f2c810:${i}`, wp(`a4f2c810:${i}`));
      scheduleMeshSave(s);
    }
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('flush écrit sans attendre l’échéance', () => {
    // La PWA passe en arrière-plan : l'OS peut la tuer avant le minuteur.
    const s = store(wp('a4f2c810:0001'));
    scheduleMeshSave(s);
    flushMeshSave(s);
    expect(loadMeshOrders()).toHaveLength(1);
  });

  it('flush ne fait rien s’il n’y a pas d’écriture en attente', () => {
    const spy = vi.spyOn(localStorage, 'setItem');
    flushMeshSave(store(wp('a4f2c810:0001')));
    expect(spy).not.toHaveBeenCalled();
  });

  it('clear annule une écriture en attente', () => {
    const s = store(wp('a4f2c810:0001'));
    scheduleMeshSave(s);
    clearMeshOrders();
    vi.advanceTimersByTime(2_000);
    expect(loadMeshOrders()).toEqual([]);
  });
});
