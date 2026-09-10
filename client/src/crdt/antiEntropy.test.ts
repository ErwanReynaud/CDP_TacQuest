// Anti-entropie : réémission ciblée, gigue, suppression, digests tournants.

import { describe, expect, it } from 'vitest';
import type { OrderMessage } from '@tq/shared/protocol';
import {
  DIGEST_INTERVAL_MS,
  DIGEST_MAX_ENTRIES,
  RESEND_JITTER_MS,
  RESEND_SUPPRESSION_MS,
} from '@tq/shared/mesh/constants';
import { AntiEntropy, type DigestEntry } from './antiEntropy';
import type { OrderStore } from './orders';

const T0 = 1_767_225_600_000;
const A = 0x11;

const order = (node: number, seq: number, ts = T0): OrderMessage => ({
  id: `${node.toString(16).padStart(8, '0')}:${seq.toString(16).padStart(4, '0')}`,
  authorId: 'x',
  ts,
  kind: 'waypoint',
  payload: { kind: 'waypoint', name: `P${seq}`, lat: 45, lng: 5 },
});

interface Harness {
  ae: AntiEntropy;
  orders: OrderStore;
  digests: DigestEntry[][];
  reqs: { node: number; from: number; count: number }[];
  resent: string[];
  hold: (node: number, seq: number, now?: number) => void;
}

/** `random` déterministe : gigue toujours à mi-course, sans surprise. */
function harness(random = () => 0.5): Harness {
  const orders: OrderStore = new Map();
  const digests: DigestEntry[][] = [];
  const reqs: { node: number; from: number; count: number }[] = [];
  const resent: string[] = [];
  const ae = new AntiEntropy({
    orders,
    sendDigest: (e) => digests.push(e),
    sendReq: (node, from, count) => reqs.push({ node, from, count }),
    resendOrder: (o) => resent.push(o.id),
    random,
  });
  const hold = (node: number, seq: number, now = T0): void => {
    const o = order(node, seq);
    orders.set(o.id, o);
    ae.observe(o, now);
  };
  return { ae, orders, digests, reqs, resent, hold };
}

describe('réémission déclenchée par un digest', () => {
  it('réémet ce qui manque au pair et que nous détenons', () => {
    const h = harness();
    for (const s of [1, 2, 3]) h.hold(A, s);
    // Le pair n'a que jusqu'à 1 : il lui manque 2 et 3.
    h.ae.onDigest([{ node: A, upto: 1 }], T0 + RESEND_SUPPRESSION_MS);
    h.ae.tick(T0 + RESEND_SUPPRESSION_MS + RESEND_JITTER_MS);
    expect(h.resent.sort()).toEqual(['00000011:0002', '00000011:0003']);
  });

  it('ne réémet rien à un pair à jour', () => {
    const h = harness();
    for (const s of [1, 2]) h.hold(A, s);
    h.ae.onDigest([{ node: A, upto: 2 }], T0 + RESEND_SUPPRESSION_MS);
    h.ae.tick(T0 + RESEND_SUPPRESSION_MS + RESEND_JITTER_MS);
    expect(h.resent).toEqual([]);
  });

  it('ne réémet pas ce qu’on ne détient pas', () => {
    const h = harness();
    h.hold(A, 1);
    h.ae.onDigest([{ node: A, upto: 0 }], T0 + RESEND_SUPPRESSION_MS);
    h.ae.tick(T0 + RESEND_SUPPRESSION_MS + RESEND_JITTER_MS);
    expect(h.resent).toEqual(['00000011:0001']);
  });

  it('attend la gigue avant d’émettre', () => {
    // Sans ce délai, tous les nœuds détenant l'ordre répondraient au même
    // instant et se collisionneraient sur le canal.
    const h = harness(() => 0.9);
    h.hold(A, 1);
    const t = T0 + RESEND_SUPPRESSION_MS;
    h.ae.onDigest([{ node: A, upto: 0 }], t);
    h.ae.tick(t + 1_000);
    expect(h.resent).toEqual([]);
    h.ae.tick(t + RESEND_JITTER_MS);
    expect(h.resent).toEqual(['00000011:0001']);
  });
});

describe('suppression', () => {
  it('annule une réémission si un pair a répondu avant nous', () => {
    // C'est ce qui transforme « tout le monde répond » en « un seul répond ».
    const h = harness(() => 0.9);
    h.hold(A, 1);
    const t = T0 + RESEND_SUPPRESSION_MS;
    h.ae.onDigest([{ node: A, upto: 0 }], t);
    // Un autre nœud a été plus rapide : on entend l'ordre passer.
    h.ae.observe(order(A, 1), t + 2_000);
    h.ae.tick(t + RESEND_JITTER_MS);
    expect(h.resent).toEqual([]);
  });

  it('ne programme rien pour un ordre entendu tout récemment', () => {
    const h = harness();
    h.hold(A, 1, T0);
    h.ae.onDigest([{ node: A, upto: 0 }], T0 + 1_000);
    expect(h.ae.stats().scheduled).toBe(0);
  });

  it('réémet à nouveau une fois la fenêtre écoulée', () => {
    const h = harness();
    h.hold(A, 1, T0);
    const t = T0 + RESEND_SUPPRESSION_MS + 1;
    h.ae.onDigest([{ node: A, upto: 0 }], t);
    h.ae.tick(t + RESEND_JITTER_MS);
    expect(h.resent).toEqual(['00000011:0001']);
  });

  it('borne la rafale déclenchée par un seul digest', () => {
    const h = harness();
    for (let s = 1; s <= 30; s++) h.hold(A, s);
    h.ae.onDigest([{ node: A, upto: 0 }], T0 + RESEND_SUPPRESSION_MS);
    // Un digest ne doit pas provoquer trente émissions d'affilée.
    expect(h.ae.stats().scheduled).toBeLessThanOrEqual(8);
  });
});

describe('requêtes explicites', () => {
  it('sert une plage demandée', () => {
    const h = harness();
    for (const s of [4, 5, 6]) h.hold(A, s);
    const t = T0 + RESEND_SUPPRESSION_MS;
    h.ae.onReq(A, 4, 3, t);
    h.ae.tick(t + RESEND_JITTER_MS);
    expect(h.resent.sort()).toEqual(['00000011:0004', '00000011:0005', '00000011:0006']);
  });

  it('ignore une plage qu’on ne détient pas', () => {
    const h = harness();
    h.hold(A, 4);
    h.ae.onReq(A, 10, 5, T0 + RESEND_SUPPRESSION_MS);
    expect(h.ae.stats().scheduled).toBe(0);
  });

  it('demande nos propres trous, invisibles pour les pairs', () => {
    // Un digest n'annonce que le plus haut contigu : personne ne peut deviner
    // qu'il nous manque 2 et 3, c'est à nous de le réclamer.
    const h = harness();
    for (const s of [1, 4, 5]) h.hold(A, s);
    // Les demandes partent avec une gigue, comme les réémissions : plusieurs
    // retardataires ne doivent pas réclamer au même instant.
    h.ae.tick(T0 + DIGEST_INTERVAL_MS);
    expect(h.reqs).toEqual([]);
    h.ae.tick(T0 + DIGEST_INTERVAL_MS + RESEND_JITTER_MS);
    expect(h.reqs).toEqual([{ node: A, from: 2, count: 2 }]);
  });
});

describe('émission des digests', () => {
  it('n’émet rien quand on ne détient rien', () => {
    const h = harness();
    h.ae.tick(T0 + DIGEST_INTERVAL_MS);
    expect(h.digests).toEqual([]);
  });

  it('respecte la cadence', () => {
    const h = harness();
    h.hold(A, 1);
    h.ae.tick(T0 + DIGEST_INTERVAL_MS);
    expect(h.digests).toHaveLength(1);
    h.ae.tick(T0 + DIGEST_INTERVAL_MS + 1_000);
    expect(h.digests).toHaveLength(1);
    h.ae.tick(T0 + 2 * DIGEST_INTERVAL_MS + 1_000);
    expect(h.digests).toHaveLength(2);
  });

  it('annonce le plus haut contigu, pas le plus haut détenu', () => {
    const h = harness();
    for (const s of [1, 2, 9]) h.hold(A, s);
    h.ae.tick(T0 + DIGEST_INTERVAL_MS);
    expect(h.digests[0]).toEqual([{ node: A, upto: 2 }]);
  });

  it('tourne sur les auteurs quand le vecteur ne tient pas dans une trame', () => {
    // 40 membres à 6 octets font 240 o pour un budget de 200 : on annonce par
    // sous-ensembles, en tournant pour que tous finissent couverts.
    const h = harness();
    for (let node = 1; node <= 40; node++) h.hold(node, 1);
    h.ae.tick(T0 + DIGEST_INTERVAL_MS);
    h.ae.tick(T0 + 2 * DIGEST_INTERVAL_MS);
    expect(h.digests[0]).toHaveLength(DIGEST_MAX_ENTRIES);
    expect(h.digests[1]).toHaveLength(DIGEST_MAX_ENTRIES);
    const couverts = new Set([...h.digests[0]!, ...h.digests[1]!].map((e) => e.node));
    expect(couverts.size).toBe(40);
  });
});

describe('compaction', () => {
  it('oublie un ordre purgé et cesse de l’annoncer', () => {
    const h = harness();
    for (const s of [1, 2]) h.hold(A, s);
    h.orders.delete('00000011:0002');
    h.ae.forget('00000011:0002');
    h.ae.tick(T0 + DIGEST_INTERVAL_MS);
    expect(h.digests[0]).toEqual([{ node: A, upto: 1 }]);
  });
});
