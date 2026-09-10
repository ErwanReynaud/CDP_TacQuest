// Scénario de terrain complet sur mesh simulé.
//
// Une section de 8 postes, 30 minutes d'activité : annonces, positions,
// figurés, plots, corrections, effacement. On vérifie deux choses que les
// tests unitaires ne peuvent pas voir — que tout le monde converge vers la
// même carte, et que le volume émis reste compatible avec un lien LoRa.

import { describe, expect, it } from 'vitest';
import type { MemberPublic, OrderMessage, Position } from '@tq/shared/protocol';
import { MESH_MAX_PAYLOAD, MESH_POSITION_INTERVAL_MS } from '@tq/shared/mesh/constants';
import { mergeOrder, type OrderStore } from '../crdt/orders';
import { visibleGraphics, visibleWaypoints } from '../map/orderFilter';
import { MockMesh, type MockRadio } from './mockRadio';
import { encodePosition } from './positionCodec';
import { MeshTransport } from '../transport/meshTransport';

const ANCHOR = { lat: 45.0, lng: 5.0 };
const EPOCH = 1_767_225_600;
const ROOM = { anchor: ANCHOR, epochSec: EPOCH };
const T0 = (EPOCH + 60) * 1000;
const SECTION_SIZE = 8;
const MISSION_MS = 30 * 60_000;

interface Node {
  num: number;
  radio: MockRadio;
  orders: OrderStore;
  members: Map<string, MemberPublic>;
  transport: MeshTransport;
  seq: number;
}

function section(mesh: MockMesh): Node[] {
  return Array.from({ length: SECTION_SIZE }, (_, i) => {
    const num = 0x100 + i;
    const radio = mesh.radio(num);
    const orders: OrderStore = new Map();
    const members = new Map<string, MemberPublic>();
    return {
      num, radio, orders, members, seq: 0,
      transport: new MeshTransport({ radio, room: ROOM, orders, members, emit: () => {} }),
    };
  });
}

/** Identifiant dans l'espace du nœud, comme le ferait issueOrderId(). */
function nextId(n: Node): string {
  return `${n.num.toString(16).padStart(8, '0')}:${(n.seq++).toString(16).padStart(4, '0')}`;
}

/** Composer = appliquer chez soi puis émettre, comme le fait la façade. */
async function compose(n: Node, o: OrderMessage): Promise<void> {
  mergeOrder(n.orders, o);
  await n.transport.sendOrder(o);
}

const fix = (ts: number, i: number): Position => ({
  lat: 45.0 + i * 0.001, lng: 5.0 + i * 0.001, accuracy: 6, heading: null, speed: null, ts,
});

const waypoint = (id: string, ts: number, name: string, i: number): OrderMessage => ({
  id, authorId: 'x', ts, kind: 'waypoint',
  payload: { kind: 'waypoint', name, lat: 45.01 + i * 0.002, lng: 5.02, sidc: 'SHGP-------' },
});

const graphic = (id: string, ts: number, i: number): OrderMessage => ({
  id, authorId: 'x', ts, kind: 'graphic',
  payload: {
    kind: 'graphic',
    geojson: {
      type: 'Feature', properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [[5.0 + i * 0.001, 45.0], [5.005 + i * 0.001, 45.004], [5.01 + i * 0.001, 45.002]],
      },
    },
    style: { color: '#0033ff', weight: 4, mission: 'reco', label: `AXE ${i}` },
  },
});

describe('mission de 30 minutes, section de 8 postes', () => {
  it('converge et tient le budget radio', async () => {
    const mesh = new MockMesh();
    const nodes = section(mesh);
    const chef = nodes[0]!;

    // --- 1. chacun annonce son indicatif (NODEINFO_APP) ---
    for (const [i, n] of nodes.entries()) {
      await n.radio.setOwner({ callsign: `ALPHA ${10 + i}`, shortName: `A${10 + i}` });
    }
    // Tout le monde connaît tout le monde, sauf soi-même.
    for (const n of nodes) expect(n.members.size).toBe(SECTION_SIZE - 1);

    // --- 2. positions pendant 30 minutes, à la cadence mesh ---
    let positionPackets = 0;
    for (let t = 0; t <= MISSION_MS; t += MESH_POSITION_INTERVAL_MS) {
      for (const [i, n] of nodes.entries()) {
        if (n.transport.sendPosition(fix(T0 + t, i), T0 + t)) positionPackets++;
      }
    }

    // --- 3. le chef pose l'ordre initial : 6 figurés, 4 plots ---
    for (let i = 0; i < 6; i++) await compose(chef, graphic(nextId(chef), T0 + 1000 + i, i));
    for (let i = 0; i < 4; i++) {
      await compose(chef, waypoint(nextId(chef), T0 + 2000 + i, `OBJ ${i}`, i));
    }

    // --- 4. deux équipiers signalent des plots ENI ---
    for (const n of [nodes[3]!, nodes[5]!]) {
      await compose(n, waypoint(nextId(n), T0 + 3000, 'ENI', n.num % 5));
    }

    // --- 5. une correction : un plot rectifié après avoir été effacé ---
    const eni = nodes[3]!;
    const eniId = `${eni.num.toString(16).padStart(8, '0')}:0000`;
    await compose(chef, {
      id: nextId(chef), authorId: 'x', ts: T0 + 4000, kind: 'remove',
      payload: { kind: 'remove', orderId: eniId },
    });
    // L'auteur corrige : add-wins, le plot revient chez tout le monde.
    await compose(eni, waypoint(eniId, T0 + 5000, 'ENI confirmé', 3));

    // --- vérification : tout le monde voit exactement la même carte ---
    const reference = {
      graphics: visibleGraphics(chef.orders).map((g) => g.id).sort(),
      waypoints: visibleWaypoints(chef.orders).map((w) => w.id).sort(),
    };
    for (const n of nodes) {
      expect(visibleGraphics(n.orders).map((g) => g.id).sort()).toEqual(reference.graphics);
      expect(visibleWaypoints(n.orders).map((w) => w.id).sort()).toEqual(reference.waypoints);
    }
    expect(reference.graphics).toHaveLength(6);
    // 4 objectifs + 2 plots ENI, dont celui corrigé après suppression.
    expect(reference.waypoints).toHaveLength(6);
    const corrected = visibleWaypoints(nodes[7]!.orders).find((w) => w.id === eniId);
    expect(corrected?.name).toBe('ENI confirmé');

    // --- budget radio ---
    const orderBytes = mesh.totalBytes();
    const positionBytes = positionPackets * encodePosition(fix(T0, 0)).length;
    const orderPackets = mesh.sent.filter((s) => s.kind === 'private').length;

    // Aucune trame ne dépasse le budget.
    expect(Math.max(...mesh.sent.map((s) => s.bytes))).toBeLessThanOrEqual(MESH_MAX_PAYLOAD);

    // 8 postes × 16 relevés sur 30 min : la cadence mesh tient la charge, là
    // où les 30 s du mode serveur auraient produit 4 fois plus de trafic.
    expect(positionPackets).toBe(SECTION_SIZE * 16);

    // Les ordres tactiques d'une mission entière tiennent en quelques
    // centaines d'octets : c'est le résultat que le codec binaire visait.
    expect(orderPackets).toBe(14);
    expect(orderBytes).toBeLessThan(700);

    // Sur 30 minutes, le total reste très en deçà de ce qu'un canal LoRa
    // transporte, positions comprises (elles dominent largement le volume).
    expect(orderBytes + positionBytes).toBeLessThan(5_000);
  });

  it('un effacement général coûte un paquet, pas un par figuré', async () => {
    const mesh = new MockMesh();
    const nodes = section(mesh);
    const chef = nodes[0]!;
    for (let i = 0; i < 20; i++) await compose(chef, waypoint(nextId(chef), T0 + i, `P${i}`, i));
    expect(visibleWaypoints(nodes[4]!.orders)).toHaveLength(20);

    const before = mesh.sent.length;
    await compose(chef, {
      id: nextId(chef), authorId: 'x', ts: T0 + 100, kind: 'clear',
      payload: { kind: 'clear', beforeTs: T0 + 100 },
    });
    expect(mesh.sent.length - before).toBe(1);
    for (const n of nodes) expect(visibleWaypoints(n.orders)).toHaveLength(0);
  });

  it('un poste isolé puis revenu retrouve la carte complète', async () => {
    const mesh = new MockMesh();
    const nodes = section(mesh);
    const chef = nodes[0]!;
    const isole = nodes[6]!;

    mesh.partition('gros', nodes.filter((n) => n !== isole).map((n) => n.num));
    mesh.partition('isole', [isole.num]);

    const composed: OrderMessage[] = [];
    for (let i = 0; i < 5; i++) {
      const o = graphic(nextId(chef), T0 + i, i);
      composed.push(o);
      await compose(chef, o);
    }
    expect(visibleGraphics(isole.orders)).toHaveLength(0);
    expect(visibleGraphics(nodes[1]!.orders)).toHaveLength(5);

    // Retour à portée : le rattrapage est une réémission des ordres manquants
    // (DIGEST/REQ dans le protocole ; ici on simule leur effet).
    mesh.heal();
    for (const o of composed) await chef.transport.sendOrder(o);

    expect(visibleGraphics(isole.orders).map((g) => g.id).sort())
      .toEqual(visibleGraphics(chef.orders).map((g) => g.id).sort());
  });
});
