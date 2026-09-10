// Bout-en-bout du chemin mesh, sur radios simulées.
//
// Deux nœuds échangent réellement des trames binaires : encodage, diffusion
// sur le mesh simulé, décodage, fusion CRDT. Ce que ces tests couvrent est
// exactement ce qu'un test avec deux modules sur une table couvrirait, à la
// couche radio près.

import { beforeEach, describe, expect, it } from 'vitest';
import type { MemberPublic, OrderMessage, Position } from '@tq/shared/protocol';
import { MESH_MAX_PAYLOAD, MESH_POSITION_INTERVAL_MS } from '@tq/shared/mesh/constants';
import { visibleGraphics, visibleWaypoints } from '../map/orderFilter';
import { mergeOrder, type OrderStore } from '../crdt/orders';
import { MockMesh, type MockRadio } from '../mesh/mockRadio';
import { MeshTransport } from './meshTransport';
import { resetOrderIds } from './orderIds';

const ANCHOR = { lat: 45.0, lng: 5.0 };
const EPOCH = 1_767_225_600;
const ROOM = { anchor: ANCHOR, epochSec: EPOCH };
const TS = (EPOCH + 3600) * 1000;

/** Un nœud complet : radio simulée, magasin d'ordres isolé, transport. */
interface Node {
  radio: MockRadio;
  orders: OrderStore;
  members: Map<string, MemberPublic>;
  transport: MeshTransport;
  events: string[];
}

function node(mesh: MockMesh, nodeNum: number, room = ROOM): Node {
  const radio = mesh.radio(nodeNum);
  const orders: OrderStore = new Map();
  const members = new Map<string, MemberPublic>();
  const events: string[] = [];
  const transport = new MeshTransport({
    radio, room, orders, members,
    emit: (e) => events.push(e),
  });
  return { radio, orders, members, transport, events };
}

const wp = (id: string, ts: number, name = 'ENI'): OrderMessage => ({
  id, authorId: 'x', ts, kind: 'waypoint',
  payload: { kind: 'waypoint', name, lat: 45.01, lng: 5.02, sidc: 'SHGP-------' },
});

const gfx = (id: string, ts: number): OrderMessage => ({
  id, authorId: 'x', ts, kind: 'graphic',
  payload: {
    kind: 'graphic',
    geojson: {
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: [[5.0, 45.0], [5.01, 45.008]] },
    },
    style: { color: '#0033ff', weight: 4, arrow: true },
  },
});

const fix = (ts: number, lat = 45.01): Position => ({
  lat, lng: 5.02, accuracy: 5, heading: null, speed: null, ts,
});

beforeEach(() => {
  resetOrderIds();
});

describe('transmission d’ordres entre deux nœuds', () => {
  it('transporte un plot ENI de bout en bout', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);

    // L'identifiant doit appartenir à l'espace du nœud émetteur : le codec
    // élide l'auteur et le reconstruit depuis l'en-tête du paquet.
    expect(await a.transport.sendOrder(wp('00000011:0001', TS))).toBe(true);

    const received = visibleWaypoints(b.orders);
    expect(received).toHaveLength(1);
    expect(received[0]!.name).toBe('ENI');
    expect(received[0]!.lat).toBeCloseTo(45.01, 4);
    expect(received[0]!.sidc).toBe('SHGP-------');
    // L'auteur est reconstruit depuis le nœud émetteur, pas transmis.
    expect(received[0]!.authorId).toBe('00000011');
    expect(b.events).toContain('orders');
  });

  it('transporte un figuré graphique avec son style', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    await a.transport.sendOrder(gfx('00000011:0002', TS));

    const out = visibleGraphics(b.orders);
    expect(out).toHaveLength(1);
    expect(out[0]!.style.arrow).toBe(true);
    expect(out[0]!.style.color).toBe('#0033ff');
    expect(out[0]!.latlngs).toHaveLength(2);
  });

  it('propage une suppression', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    await a.transport.sendOrder(wp('00000011:0003', TS));
    expect(visibleWaypoints(b.orders)).toHaveLength(1);

    await a.transport.sendOrder({
      id: '00000011:0004', authorId: 'x', ts: TS + 1000, kind: 'remove',
      payload: { kind: 'remove', orderId: '00000011:0003' },
    });
    expect(visibleWaypoints(b.orders)).toHaveLength(0);
  });

  it('efface la carte de tout le monde en un seul paquet', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    for (let i = 0; i < 10; i++) await a.transport.sendOrder(wp(`00000011:${i.toString(16).padStart(4, '0')}`, TS + i));
    expect(visibleWaypoints(b.orders)).toHaveLength(10);

    const before = mesh.sent.length;
    await a.transport.sendOrder({
      id: '00000011:00ff', authorId: 'x', ts: TS + 100, kind: 'clear',
      payload: { kind: 'clear', beforeTs: TS + 100 },
    });
    expect(mesh.sent.length - before).toBe(1);
    expect(visibleWaypoints(b.orders)).toHaveLength(0);
  });

  it('ne renvoie pas à l’émetteur ses propres trames', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    await a.transport.sendOrder(wp('00000011:0005', TS));
    // L'application locale est faite par la façade, pas par la boucle radio.
    expect(a.orders.size).toBe(0);
  });
});

describe('garde-fous d’émission', () => {
  it('refuse un ordre composé sous un autre nœud', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    // Identifiant d'un autre espace : le destinataire reconstruirait un auteur
    // faux, et un `remove` viserait le mauvais figuré.
    expect(await a.transport.sendOrder(wp('00009999:0001', TS))).toBe(false);
    expect(b.orders.size).toBe(0);
  });

  it('refuse un identifiant uuid hérité', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    expect(await a.transport.sendOrder(wp('550e8400-e29b-41d4-a716-446655440000', TS))).toBe(false);
  });

  it('met en attente tant qu’aucune ancre n’est connue, puis rejoue', async () => {
    const mesh = new MockMesh();
    const radio = mesh.radio(0x11);
    const b = node(mesh, 0x22);
    const orders: OrderStore = new Map();
    // Aucune salle fournie : pas d'ancre, donc pas d'encodage possible.
    const t = new MeshTransport({ radio, orders, members: new Map(), emit: () => {} });

    expect(await t.sendOrder(wp('00000011:0007', TS))).toBe(false);
    expect(b.orders.size).toBe(0);

    // Un premier fix GPS établit l'ancre et vide la file d'attente.
    t.sendPosition(fix(TS));
    await Promise.resolve();
    expect(visibleWaypoints(b.orders)).toHaveLength(1);
  });

  it('ne dépasse jamais le budget de charge utile', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    // Le mesh simulé lève au-delà du budget : un tracé chargé doit être
    // simplifié par le transport, pas rejeté ni fragmenté.
    const heavy: OrderMessage = {
      id: '00000011:0008', authorId: 'x', ts: TS, kind: 'graphic',
      payload: {
        kind: 'graphic',
        geojson: {
          type: 'Feature', properties: {},
          geometry: {
            type: 'LineString',
            coordinates: Array.from({ length: 60 }, (_, i) => [5.0 + i * 0.0011, 45.0 + i * 0.0008]),
          },
        },
        style: { color: '#af52de', weight: 4, label: 'AXE PRINCIPAL NORD-EST' },
      },
    };
    expect(await a.transport.sendOrder(heavy)).toBe(true);
    expect(Math.max(...mesh.sent.map((s) => s.bytes))).toBeLessThanOrEqual(MESH_MAX_PAYLOAD);
  });
});

describe('positions', () => {
  it('diffuse la position et alimente le roster du pair', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    // Le pair doit connaître le membre pour que sa position s'y applique.
    await a.radio.setOwner({ callsign: 'ALPHA 11', shortName: 'A11' });
    expect(b.members.get('00000011')?.callsign).toBe('ALPHA 11');

    a.transport.sendPosition(fix(TS), TS);
    expect(b.members.get('00000011')?.lastPosition?.lat).toBeCloseTo(45.01, 5);
  });

  it('respecte la cadence mesh, bien plus lente qu’en mode serveur', () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    expect(a.transport.sendPosition(fix(TS), TS)).toBe(true);
    // 40 nœuds toutes les 30 s satureraient le canal : les envois rapprochés
    // sont écartés, ce qui n'est pas une erreur.
    expect(a.transport.sendPosition(fix(TS + 1000), TS + 1000)).toBe(false);
    expect(a.transport.sendPosition(fix(TS + MESH_POSITION_INTERVAL_MS), TS + MESH_POSITION_INTERVAL_MS)).toBe(true);
  });

  it('ignore une position plus ancienne arrivée après', () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    b.members.set('00000011', {
      id: '00000011', callsign: 'A11', role: 'GV', isLeader: false,
      connected: true, lastSeen: TS, lastPosition: null,
    });
    a.transport.sendPosition(fix(TS + 60_000, 45.5), TS + 60_000);
    a.transport.sendPosition(fix(TS, 45.1), TS + 10 * MESH_POSITION_INTERVAL_MS);
    expect(b.members.get('00000011')!.lastPosition!.lat).toBeCloseTo(45.5, 5);
  });
});

describe('partition réseau', () => {
  it('converge après rétablissement du contact', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);

    /** Composer un ordre = l'appliquer chez soi puis l'émettre, comme la façade. */
    const compose = async (n: Node, o: OrderMessage): Promise<void> => {
      mergeOrder(n.orders, o);
      await n.transport.sendOrder(o);
    };

    const nordENI = wp('00000011:0010', TS, 'ENI nord');
    const sudENI = wp('00000022:0010', TS + 100, 'ENI sud');

    // Les deux groupes se perdent de vue et composent chacun de leur côté.
    mesh.partition('nord', [0x11]);
    mesh.partition('sud', [0x22]);
    await compose(a, nordENI);
    await compose(b, sudENI);
    // Chacun ne voit que le sien : le mesh est coupé.
    expect(visibleWaypoints(a.orders).map((w) => w.name)).toEqual(['ENI nord']);
    expect(visibleWaypoints(b.orders).map((w) => w.name)).toEqual(['ENI sud']);

    // Contact rétabli : chacun réémet ce qu'il a composé.
    mesh.heal();
    await a.transport.sendOrder(nordENI);
    await b.transport.sendOrder(sudENI);

    const nord = visibleWaypoints(a.orders).map((w) => w.name).sort();
    const sud = visibleWaypoints(b.orders).map((w) => w.name).sort();
    expect(nord).toEqual(sud);
    expect(nord).toEqual(['ENI nord', 'ENI sud']);
  });

  it('encaisse un canal qui perd des paquets, par réémission', async () => {
    // 40 % de perte, tirage déterministe : sans réémission le figuré n'arrive
    // pas, avec réémission il finit par passer.
    let n = 0;
    const mesh = new MockMesh({ lossRate: 0.4, random: () => [0.1, 0.9, 0.1, 0.9][n++ % 4]! });
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    for (let i = 0; i < 4; i++) await a.transport.sendOrder(wp('00000011:0011', TS));
    expect(visibleWaypoints(b.orders)).toHaveLength(1);
  });
});
