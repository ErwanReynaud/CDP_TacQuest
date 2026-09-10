// Gouverneur d'airtime : priorités, fusion, saturation.

import { describe, expect, it, vi } from 'vitest';
import { MESH_PRESETS } from '@tq/shared/mesh/airtime';
import { AirtimeGovernor, type Priority } from './airtimeGovernor';

const T0 = 1_000_000;

/** Trame de `n` octets utiles. */
const frame = (n: number): Uint8Array => new Uint8Array(n);

interface Harness {
  gov: AirtimeGovernor;
  sent: string[];
  submit: (label: string, priority: Priority, size?: number, key?: string, at?: number) => boolean;
}

function harness(maxQueue = 64): Harness {
  const sent: string[] = [];
  const gov = new AirtimeGovernor({ params: MESH_PRESETS.LongFast, maxQueue });
  const submit = (
    label: string,
    priority: Priority,
    size = 40,
    coalesceKey?: string,
    at = T0,
  ): boolean =>
    gov.submit(
      { bytes: frame(size), priority, coalesceKey, send: () => { sent.push(label); return Promise.resolve(); } },
      at,
    );
  return { gov, sent, submit };
}

/** Consomme le budget horaire en laissant la file vide (cf. commentaire plus bas). */
function saturateQueueEmpty(h: Harness): void {
  while (h.gov.stats(T0).remainingMs >= h.gov.airtimeOf(40)) h.submit('fill', 'order', 40);
  h.sent.length = 0;
  expect(h.gov.pending()).toBe(0);
}

describe('canal libre', () => {
  it('émet immédiatement, sans latence artificielle', () => {
    const h = harness();
    expect(h.submit('a', 'order')).toBe(true);
    expect(h.sent).toEqual(['a']);
    expect(h.gov.pending()).toBe(0);
  });

  it('compte le temps consommé, en-tête Meshtastic compris', () => {
    const h = harness();
    h.submit('a', 'order', 40);
    const s = h.gov.stats(T0);
    // 40 o utiles + 16 o d'en-tête en LongFast : plusieurs centaines de ms.
    expect(s.usedMs).toBeGreaterThan(400);
    expect(s.remainingMs).toBeLessThan(36_000);
    expect(s.sent).toBe(1);
  });
});

describe('budget saturé', () => {
  /**
   * Consomme le budget horaire sans rien laisser en file : on s'arrête dès
   * qu'une trame de plus n'y tiendrait pas. Tout ce qui est soumis ensuite est
   * donc nécessairement mis en attente.
   */
  function saturate(h: Harness): void {
    while (h.gov.stats(T0).remainingMs >= h.gov.airtimeOf(40)) h.submit('fill', 'order', 40);
    h.sent.length = 0;
    expect(h.gov.pending()).toBe(0);
  }

  it('met en file au lieu d’émettre', () => {
    const h = harness();
    saturate(h);
    expect(h.submit('tardif', 'order')).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.gov.pending()).toBeGreaterThan(0);
  });

  it('sert l’alerte avant l’ordre, l’ordre avant la position, la position avant le digest', () => {
    // L'ordre traduit une doctrine : une alerte de contact passe avant un
    // tracé, un tracé avant une position qui sera de toute façon remplacée.
    const h = harness();
    saturate(h);
    h.submit('digest', 'digest');
    h.submit('position', 'position');
    h.submit('ordre', 'order');
    h.submit('alerte', 'alert');
    expect(h.sent).toEqual([]);

    // Une heure plus tard, le budget est de nouveau entier.
    h.gov.drain(T0 + 3_600_001);
    expect(h.sent).toEqual(['alerte', 'ordre', 'position', 'digest']);
  });

  it('départage deux trames de même priorité par l’ancienneté', () => {
    const h = harness();
    saturate(h);
    h.submit('vieux', 'order', 40, undefined, T0);
    h.submit('recent', 'order', 40, undefined, T0 + 1_000);
    h.gov.drain(T0 + 3_600_001);
    expect(h.sent).toEqual(['vieux', 'recent']);
  });

  it('ne libère que ce que le budget permet', () => {
    const h = harness();
    saturate(h);
    // 30 trames pleines en attente : le budget reconstitué n'en couvre qu'une
    // vingtaine, une trame pleine coûtant près de deux secondes.
    for (let i = 0; i < 30; i++) h.submit(`q${i}`, 'order', 200);
    const n = h.gov.drain(T0 + 3_600_001);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(30);
    expect(h.gov.pending()).toBeGreaterThan(0);
  });
});

describe('fusion des envois périmés', () => {
  it('ne garde qu’une position en attente', () => {
    // Une position périmée n'a aucune valeur une fois qu'une plus récente
    // existe : l'émettre afficherait un équipier là où il n'est plus.
    const h = harness();
    saturateQueueEmpty(h);

    h.submit('pos1', 'position', 40, 'position');
    h.submit('pos2', 'position', 40, 'position');
    h.submit('pos3', 'position', 40, 'position');
    expect(h.gov.pending('position')).toBe(1);

    h.gov.drain(T0 + 3_600_001);
    expect(h.sent).toEqual(['pos3']);
    expect(h.gov.stats(T0).coalesced).toBe(2);
  });

  it('ne fusionne pas des trames de clés différentes', () => {
    const h = harness();
    saturateQueueEmpty(h);
    h.submit('a', 'digest', 40, 'digest');
    h.submit('b', 'position', 40, 'position');
    expect(h.gov.pending()).toBe(2);
  });
});

describe('file saturée', () => {
  it('sacrifie la trame la moins prioritaire pour faire place à une plus urgente', () => {
    const h = harness(3);
    saturateQueueEmpty(h);

    h.submit('d1', 'digest');
    h.submit('d2', 'digest');
    h.submit('d3', 'digest');
    expect(h.gov.pending()).toBe(3);

    expect(h.submit('urgent', 'alert')).toBe(true);
    expect(h.gov.pending('digest')).toBe(2);
    expect(h.gov.pending('alert')).toBe(1);
    expect(h.gov.stats(T0).dropped).toBe(1);
  });

  it('écarte la nouvelle plutôt que d’évincer une plus prioritaire', () => {
    // Une avalanche de digests ne doit pas chasser des ordres de la file.
    const h = harness(2);
    saturateQueueEmpty(h);
    h.submit('o1', 'order');
    h.submit('o2', 'order');
    expect(h.submit('d1', 'digest')).toBe(false);
    expect(h.gov.pending('order')).toBe(2);
    expect(h.gov.pending('digest')).toBe(0);
  });

  it('signale l’abandon dans le journal', () => {
    const log = vi.fn();
    const gov = new AirtimeGovernor({ params: MESH_PRESETS.LongFast, maxQueue: 1, log });
    const push = (p: Priority): boolean =>
      gov.submit({ bytes: frame(200), priority: p, send: () => Promise.resolve() }, T0);
    for (let i = 0; i < 40; i++) push('order');
    push('digest');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('file saturée'));
  });
});

describe('cadence de position adaptative', () => {
  it('garde la cadence de base tant que le canal est libre', () => {
    const h = harness();
    expect(h.gov.recommendedPositionIntervalMs(120_000, T0)).toBe(120_000);
  });

  it('espace les positions à mesure que le budget se consomme', () => {
    // Plutôt qu'une constante qui devine, on rend la place aux ordres quand la
    // manœuvre s'intensifie.
    const h = harness();
    for (let i = 0; i < 12; i++) h.submit(`f${i}`, 'order', 200);
    const mid = h.gov.recommendedPositionIntervalMs(120_000, T0);
    for (let i = 0; i < 12; i++) h.submit(`g${i}`, 'order', 200);
    const high = h.gov.recommendedPositionIntervalMs(120_000, T0);
    expect(mid).toBeGreaterThanOrEqual(120_000);
    expect(high).toBeGreaterThan(mid);
  });
});
