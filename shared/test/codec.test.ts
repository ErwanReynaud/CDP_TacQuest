// Tests du codec binaire : aller-retour, budgets d'octets, dégradations.

import { test } from 'vitest';
import assert from 'node:assert/strict';

import type { OrderMessage } from '../src/protocol';
import { MESH_MAX_PAYLOAD, MISSION_UNKNOWN } from '../src/mesh/constants';
import { MeshCodecError } from '../src/mesh/bytes';
import {
  type DecodeContext,
  type LineStringFeature,
  decodeFrame,
  encodeAnchor,
  encodeDigest,
  encodeMember,
  encodeOrder,
  encodeOrderFitted,
  encodeReq,
  nodeToMemberId,
} from '../src/mesh/codec';
import { encodeOffset } from '../src/mesh/geo';

const NODE = 0xa4f2c810;
const ANCHOR = { lat: 45.0, lng: 5.0 };
const EPOCH = 1_767_225_600; // 2026-01-01T00:00:00Z
const MISSIONS = ['RECO', 'FIX', 'DEF', 'COUV', 'SURV', 'INTERD'];

const ctx: DecodeContext = { anchor: ANCHOR, epochSec: EPOCH, missions: MISSIONS, from: NODE };
const TS = (EPOCH + 3600) * 1000;

function roundtrip(order: OrderMessage): { order: OrderMessage; size: number } {
  const bytes = encodeOrder(order, ctx);
  assert.ok(bytes.length <= MESH_MAX_PAYLOAD, `trame de ${bytes.length} o > ${MESH_MAX_PAYLOAD}`);
  const frame = decodeFrame(bytes, ctx);
  assert.equal(frame.kind, 'order');
  return { order: (frame as { kind: 'order'; order: OrderMessage }).order, size: bytes.length };
}

function feature(coords: [number, number][]): LineStringFeature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords },
  };
}

/** Sommets d'un ordre graphic : `geojson` est `unknown` côté protocole (le
 *  serveur relaie des ordres de clients quelconques), le codec le valide. */
function coordsOf(payload: OrderMessage['payload']): [number, number][] {
  assert.equal(payload.kind, 'graphic');
  return (payload as { geojson: LineStringFeature }).geojson.geometry.coordinates;
}

/** Tolérance d'aller-retour : le pas de quantification (1 m ≈ 1e-5°). */
function assertNear(a: number, b: number, tolDeg = 1e-5): void {
  assert.ok(Math.abs(a - b) < tolDeg, `${a} ≉ ${b}`);
}

test('plot ENI : aller-retour et budget', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:003b',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'waypoint',
    payload: { kind: 'waypoint', name: 'ENI', lat: 45.012, lng: 5.031, sidc: 'SHGP-------' },
  };
  const { order, size } = roundtrip(src);
  assert.equal(order.id, src.id);
  assert.equal(order.authorId, src.authorId);
  assert.equal(order.ts, src.ts);
  assert.equal(order.kind, 'waypoint');
  const p = order.payload as Extract<typeof order.payload, { kind: 'waypoint' }>;
  assert.equal(p.name, 'ENI');
  assert.equal(p.sidc, 'SHGP-------');
  assert.equal(p.color, undefined);
  assertNear(p.lat, 45.012);
  assertNear(p.lng, 5.031);
  assert.ok(size <= 16, `plot ENI en ${size} o, cible ≤ 16`);
});

test('point nommé : la couleur survit à l’aller-retour', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:0001',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'waypoint',
    payload: { kind: 'waypoint', name: 'OBJ ALPHA', lat: 45.1, lng: 5.1, color: '#0033ff' },
  };
  const { order } = roundtrip(src);
  const p = order.payload as Extract<typeof order.payload, { kind: 'waypoint' }>;
  assert.equal(p.color, '#0033ff');
  assert.equal(p.sidc, undefined);
  assert.equal(p.name, 'OBJ ALPHA');
});

test('rectangle : cible 10-15 octets du cahier des charges', () => {
  // Rectangle à axes alignés construit dans l'espace quantifié, puis reprojeté.
  const corners: [number, number][] = [
    [5.0, 45.0], [5.00636, 45.0], [5.00636, 45.0045], [5.0, 45.0045], [5.0, 45.0],
  ];
  const src: OrderMessage = {
    id: 'a4f2c810:0002',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'graphic',
    payload: {
      kind: 'graphic',
      geojson: feature(corners),
      style: { color: '#e8d44d', weight: 3, polygon: true },
    },
  };
  const { order, size } = roundtrip(src);
  assert.ok(size >= 10 && size <= 15, `rectangle encodé en ${size} o, cible 10-15`);
  const p = order.payload as Extract<typeof order.payload, { kind: 'graphic' }>;
  assert.equal(p.style?.polygon, true);
  assert.equal(coordsOf(p).length, 5);
  // Les 4 coins reviennent à leur place (fermeture incluse).
  for (let i = 0; i < 5; i++) {
    assertNear(coordsOf(p)[i]![0]!, corners[i]![0]!);
    assertNear(coordsOf(p)[i]![1]!, corners[i]![1]!);
  }
});

test('flèche à deux points : style et géométrie préservés', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:0003',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'graphic',
    payload: {
      kind: 'graphic',
      geojson: feature([[5.0, 45.0], [5.01, 45.008]]),
      style: { color: '#0033ff', weight: 4, arrow: true },
    },
  };
  const { order, size } = roundtrip(src);
  const p = order.payload as Extract<typeof order.payload, { kind: 'graphic' }>;
  assert.equal(p.style?.arrow, true);
  assert.equal(p.style?.weight, 4);
  assert.equal(p.style?.color, '#0033ff');
  assert.ok(size <= 20, `flèche en ${size} o`);
});

test('liseré : label et échelon', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:0004',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'graphic',
    payload: {
      kind: 'graphic',
      geojson: feature([[5.0, 45.0], [5.005, 45.002], [5.01, 45.001]]),
      style: { color: '#ff3b30', weight: 4, label: 'LIMITE NORD', echelon: 'company' },
    },
  };
  const { order } = roundtrip(src);
  const p = order.payload as Extract<typeof order.payload, { kind: 'graphic' }>;
  assert.equal(p.style?.label, 'LIMITE NORD');
  assert.equal(p.style?.echelon, 'company');
});

test('figuré de mission : index connu conservé, index inconnu dégradé en ligne simple', () => {
  const mk = (mission: string): OrderMessage => ({
    id: 'a4f2c810:0005',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'graphic',
    payload: {
      kind: 'graphic',
      geojson: feature([[5.0, 45.0], [5.004, 45.003]]),
      style: { color: '#0033ff', weight: 5, mission },
    },
  });
  const known = roundtrip(mk('COUV')).order.payload as Extract<OrderMessage['payload'], { kind: 'graphic' }>;
  assert.equal(known.style?.mission, 'COUV');

  // Une mission absente du catalogue part en MISSION_UNKNOWN : l'ordre reste
  // décodable, `mission` disparaît, le rendu retombe en ligne simple.
  const bytes = encodeOrder(mk('MISSION_FUTURE'), ctx);
  assert.ok(bytes.includes(MISSION_UNKNOWN), 'index inconnu attendu sur le fil');
  const decoded = decodeFrame(bytes, ctx);
  const p = (decoded as { kind: 'order'; order: OrderMessage }).order.payload as Extract<
    OrderMessage['payload'],
    { kind: 'graphic' }
  >;
  assert.equal(p.style?.mission, undefined);
  assert.equal(coordsOf(p).length, 2);
});

test('remove : la référence à soi élide le numéro de nœud', () => {
  const self: OrderMessage = {
    id: 'a4f2c810:0006',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'remove',
    payload: { kind: 'remove', orderId: 'a4f2c810:0002' },
  };
  const other: OrderMessage = { ...self, payload: { kind: 'remove', orderId: '0000002a:0002' } };
  const selfBytes = encodeOrder(self, ctx);
  const otherBytes = encodeOrder(other, ctx);
  assert.equal(otherBytes.length - selfBytes.length, 4, 'le nœud distant coûte exactement 4 o');
  assert.equal(selfBytes.length, 8, `remove sur soi en ${selfBytes.length} o`);

  const a = roundtrip(self).order.payload as Extract<OrderMessage['payload'], { kind: 'remove' }>;
  assert.equal(a.orderId, 'a4f2c810:0002');
  const b = roundtrip(other).order.payload as Extract<OrderMessage['payload'], { kind: 'remove' }>;
  assert.equal(b.orderId, '0000002a:0002');
});

test('ack : même forme que remove', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:0007',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'ack',
    payload: { kind: 'ack', orderId: 'a4f2c810:0002' },
  };
  const { order } = roundtrip(src);
  assert.equal(order.kind, 'ack');
  assert.equal((order.payload as { kind: 'ack'; orderId: string }).orderId, 'a4f2c810:0002');
});

test('clear : un paquet remplace N remove', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:0008',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'clear',
    payload: { kind: 'clear', beforeTs: TS },
  };
  const { order, size } = roundtrip(src);
  assert.equal((order.payload as { kind: 'clear'; beforeTs: number }).beforeTs, TS);
  assert.ok(size <= 10, `clear en ${size} o`);
});

test('texte : accents et emoji intacts', () => {
  const body = 'RAS sur objectif — ⚠️ mouvement à l’est';
  const src: OrderMessage = {
    id: 'a4f2c810:0009',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'text',
    payload: { kind: 'text', body },
  };
  const { order } = roundtrip(src);
  assert.equal((order.payload as { kind: 'text'; body: string }).body, body);
});

test('un texte trop long est tronqué, pas rejeté', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:000a',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'text',
    payload: { kind: 'text', body: 'A'.repeat(500) },
  };
  const { order, size } = roundtrip(src);
  assert.ok(size <= MESH_MAX_PAYLOAD);
  const body = (order.payload as { kind: 'text'; body: string }).body;
  assert.equal(body.length, 180);
});

test('la troncature UTF-8 ne coupe pas un caractère en deux', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:000b',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'waypoint',
    // 48 o de budget pour le nom : 30 « é » font 60 o.
    payload: { kind: 'waypoint', name: 'é'.repeat(30), lat: 45.0, lng: 5.0 },
  };
  const { order } = roundtrip(src);
  const name = (order.payload as { kind: 'waypoint'; name: string }).name;
  assert.equal(name, 'é'.repeat(24), 'tronqué sur une frontière de caractère');
  assert.ok(!name.includes('�'), 'aucun caractère de remplacement');
});

test('un point hors enveloppe est refusé explicitement', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:000c',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'waypoint',
    payload: { kind: 'waypoint', name: 'LOIN', lat: 46.0, lng: 5.0 }, // ~111 km au nord
  };
  assert.throws(() => encodeOrder(src, ctx), MeshCodecError);
  assert.equal(encodeOffset(ANCHOR, 46.0, 5.0), null);
});

test('un identifiant uuid hérité est refusé', () => {
  const src: OrderMessage = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'text',
    payload: { kind: 'text', body: 'test' },
  };
  assert.throws(() => encodeOrder(src, ctx), MeshCodecError);
});

test('une trame d’une autre version est rejetée, pas mal interprétée', () => {
  const bytes = encodeOrder(
    {
      id: 'a4f2c810:000d',
      authorId: nodeToMemberId(NODE),
      ts: TS,
      kind: 'text',
      payload: { kind: 'text', body: 'hello' },
    },
    ctx,
  );
  bytes[0] = (0x2 << 4) | (bytes[0]! & 0x0f); // version 2
  assert.throws(() => decodeFrame(bytes, ctx), MeshCodecError);
});

test('une trame tronquée lève une erreur au lieu de produire des données fausses', () => {
  const bytes = encodeOrder(
    {
      id: 'a4f2c810:000e',
      authorId: nodeToMemberId(NODE),
      ts: TS,
      kind: 'waypoint',
      payload: { kind: 'waypoint', name: 'OBJ', lat: 45.01, lng: 5.01, color: '#e8d44d' },
    },
    ctx,
  );
  assert.throws(() => decodeFrame(bytes.subarray(0, bytes.length - 3), ctx), MeshCodecError);
});

test('trames de contrôle : aller-retour', () => {
  const anchorFrame = decodeFrame(encodeAnchor(ANCHOR, EPOCH, true), ctx);
  assert.equal(anchorFrame.kind, 'control');
  const a = (anchorFrame as { kind: 'control'; frame: { anchor: typeof ANCHOR; epochSec: number; originator: boolean } }).frame;
  assert.equal(a.epochSec, EPOCH);
  assert.equal(a.originator, true);
  assertNear(a.anchor.lat, 45.0);
  assertNear(a.anchor.lng, 5.0);

  const entries = Array.from({ length: 32 }, (_, i) => ({ node: 1000 + i, upto: i * 7 }));
  const digestBytes = encodeDigest(entries);
  assert.ok(digestBytes.length <= MESH_MAX_PAYLOAD, `digest de ${digestBytes.length} o`);
  const d = decodeFrame(digestBytes, ctx);
  assert.deepEqual((d as { kind: 'control'; frame: { entries: unknown } }).frame.entries, entries);

  const req = decodeFrame(encodeReq(NODE, 12, 20), ctx);
  assert.deepEqual((req as { kind: 'control'; frame: Record<string, unknown> }).frame, {
    op: 0x8, node: NODE, from: 12, count: 20,
  });

  const mem = decodeFrame(encodeMember('ALPHA 11', true), ctx);
  const m = (mem as { kind: 'control'; frame: { callsign: string; isLeader: boolean } }).frame;
  assert.equal(m.callsign, 'ALPHA 11');
  assert.equal(m.isLeader, true);
});

test('aucune trame ne dépasse le budget, même au pire cas', () => {
  const worst: OrderMessage = {
    id: 'a4f2c810:ffff',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'graphic',
    payload: {
      kind: 'graphic',
      // 40 sommets espacés de ~100 m : le tracé le plus lourd que l'UI produise.
      geojson: feature(Array.from({ length: 40 }, (_, i) => [5.0 + i * 0.0013, 45.0 + i * 0.0009])),
      style: { color: '#af52de', weight: 4, label: 'X'.repeat(32), echelon: 'battalion', mission: 'RECO' },
    },
  };
  // Strict : le dépassement doit être signalé, jamais tronqué en silence.
  assert.throws(() => encodeOrder(worst, ctx), MeshCodecError);

  // Ajusté : la couche transport obtient une trame valide, un peu lissée.
  const fitted = encodeOrderFitted(worst, ctx);
  assert.ok(fitted.bytes.length <= MESH_MAX_PAYLOAD, `ajusté : ${fitted.bytes.length} o`);
  assert.ok(fitted.droppedPoints > 0, 'des sommets auraient dû être décimés');
  const decoded = decodeFrame(fitted.bytes, ctx);
  const p = (decoded as { kind: 'order'; order: OrderMessage }).order
    .payload as Extract<OrderMessage['payload'], { kind: 'graphic' }>;
  assert.equal(coordsOf(p).length, 40 - fitted.droppedPoints);
  assert.equal(p.style?.label, 'X'.repeat(32));
  assert.equal(p.style?.mission, 'RECO');
  // Les extrémités du tracé sont préservées par la décimation.
  const coords = coordsOf(p);
  assertNear(coords[0]![0]!, 5.0);
  assertNear(coords[coords.length - 1]![0]!, 5.0 + 39 * 0.0013);
});

test('un tracé déjà court n’est pas touché par l’ajustement', () => {
  const src: OrderMessage = {
    id: 'a4f2c810:0010',
    authorId: nodeToMemberId(NODE),
    ts: TS,
    kind: 'graphic',
    payload: {
      kind: 'graphic',
      geojson: feature([[5.0, 45.0], [5.004, 45.003], [5.008, 45.001]]),
      style: { color: '#e8d44d', weight: 4 },
    },
  };
  const fitted = encodeOrderFitted(src, ctx);
  assert.equal(fitted.droppedPoints, 0);
  assert.deepEqual(fitted.bytes, encodeOrder(src, ctx));
});
