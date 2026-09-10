// Bout-en-bout du chemin mesh, sur radios simulées.
//
// Deux nœuds échangent réellement des trames binaires : encodage, diffusion
// sur le mesh simulé, décodage, fusion CRDT. Ce que ces tests couvrent est
// exactement ce qu'un test avec deux modules sur une table couvrirait, à la
// couche radio près.

import { beforeEach, describe, expect, it } from 'vitest';
import type { MemberPublic, OrderMessage, Position } from '@tq/shared/protocol';
import {
  DIGEST_INTERVAL_MS,
  MESH_MAX_PAYLOAD,
  MESH_POSITION_INTERVAL_MS,
  RESEND_JITTER_MS,
  RESEND_SUPPRESSION_MS,
} from '@tq/shared/mesh/constants';
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

/** Horloge simulée, partagée par tous les nœuds d'un même scénario. */
const clock = { t: TS };

function node(mesh: MockMesh, nodeNum: number, room = ROOM): Node {
  const radio = mesh.radio(nodeNum);
  const orders: OrderStore = new Map();
  const members = new Map<string, MemberPublic>();
  const events: string[] = [];
  const transport = new MeshTransport({
    radio, room, orders, members,
    emit: (e) => events.push(e),
    now: () => clock.t,
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

/** Composer un ordre = l'appliquer chez soi puis l'émettre, comme le fait la façade. */
async function compose(n: Node, o: OrderMessage): Promise<void> {
  mergeOrder(n.orders, o);
  await n.transport.sendOrder(o);
}

const fix = (ts: number, lat = 45.01): Position => ({
  lat, lng: 5.02, accuracy: 5, heading: null, speed: null, ts,
});

beforeEach(() => {
  resetOrderIds();
  clock.t = TS;
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
  it('relaie l’ordre d’un autre nœud en préservant son auteur', async () => {
    // Le codec élide l'auteur : réémettre tel quel l'ordre d'un tiers
    // l'attribuerait à notre module, et un `remove` viserait le mauvais
    // figuré. L'enveloppe RELAY porte l'auteur explicitement — c'est ce qui
    // permet à un détenteur quelconque de servir un retardataire.
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    expect(await a.transport.sendOrder(wp('00009999:0001', TS))).toBe(true);
    const received = visibleWaypoints(b.orders);
    expect(received).toHaveLength(1);
    expect(received[0]!.id).toBe('00009999:0001');
    expect(received[0]!.authorId).toBe('00009999');
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

describe('anti-entropie de bout en bout', () => {
  /** Fait battre l'anti-entropie de chaque nœud jusqu'à `until`. */
  function run(nodes: Node[], from: number, until: number, stepMs = 5_000): void {
    for (let t = from; t <= until; t += stepMs) {
      clock.t = t;
      for (const n of nodes) n.transport.tick(t);
    }
  }

  it('rattrape un ordre perdu par le canal, sans intervention de l’auteur', async () => {
    // Le nœud B rate la trame. Sans anti-entropie, ce figuré est perdu pour
    // lui définitivement : l'auteur n'a aucune raison de le réémettre.
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    const c = node(mesh, 0x33);

    mesh.partition('seul', [0x22]); // B n'entend rien
    await compose(a, wp('00000011:0001', TS, 'ENI'));
    mesh.heal();
    expect(visibleWaypoints(b.orders)).toHaveLength(0);
    expect(visibleWaypoints(c.orders)).toHaveLength(1);

    // B annonce ce qu'il détient ; C, qui a l'ordre, le lui réémet.
    run([a, b, c], TS + RESEND_SUPPRESSION_MS, TS + RESEND_SUPPRESSION_MS + DIGEST_INTERVAL_MS + RESEND_JITTER_MS);

    expect(visibleWaypoints(b.orders).map((w) => w.name)).toEqual(['ENI']);
  });

  it('un seul nœud répond, grâce à la gigue et à la suppression', async () => {
    // Cinq nœuds détiennent l'ordre manquant. Sans suppression, les cinq
    // répondraient au même digest et se collisionneraient.
    const mesh = new MockMesh();
    const holders = [0x11, 0x33, 0x44, 0x55, 0x66].map((n) => node(mesh, n));
    const retardataire = node(mesh, 0x22);

    mesh.partition('seul', [0x22]);
    await compose(holders[0]!, wp('00000011:0002', TS, 'OBJ'));
    mesh.heal();

    const before = mesh.sent.length;
    const t = TS + RESEND_SUPPRESSION_MS;
    run([...holders, retardataire], t, t + DIGEST_INTERVAL_MS + RESEND_JITTER_MS * 2);

    expect(visibleWaypoints(retardataire.orders)).toHaveLength(1);
    // Digests compris, la reprise doit rester très en deçà d'une réponse par
    // détenteur multipliée par les tours de battement.
    const emitted = mesh.sent.length - before;
    expect(emitted).toBeLessThan(20);
  });

  it('réclame ses propres trous, invisibles pour les pairs', async () => {
    // Un digest n'annonce que le plus haut contigu : personne ne peut deviner
    // qu'il manque un ordre au milieu de la séquence.
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);

    await compose(a, wp('00000011:0001', TS, 'un'));
    mesh.partition('seul', [0x22]);
    await compose(a, wp('00000011:0002', TS + 10, 'deux'));
    mesh.heal();
    await compose(a, wp('00000011:0003', TS + 20, 'trois'));

    // B détient 1 et 3 : le trou est en 2.
    expect(visibleWaypoints(b.orders).map((w) => w.name).sort()).toEqual(['trois', 'un']);

    const t = TS + RESEND_SUPPRESSION_MS;
    run([a, b], t, t + DIGEST_INTERVAL_MS + RESEND_JITTER_MS);
    expect(visibleWaypoints(b.orders).map((w) => w.name).sort()).toEqual(['deux', 'trois', 'un']);
  });

  it('ne produit aucun trafic quand tout le monde est à jour', async () => {
    const mesh = new MockMesh();
    const a = node(mesh, 0x11);
    const b = node(mesh, 0x22);
    await compose(a, wp('00000011:0004', TS, 'ENI'));

    const t = TS + RESEND_SUPPRESSION_MS;
    run([a, b], t, t + DIGEST_INTERVAL_MS + RESEND_JITTER_MS);
    const afterFirstSync = mesh.sent.length;
    // Deuxième période : des digests, mais aucune réémission d'ordre.
    run([a, b], t + DIGEST_INTERVAL_MS * 2, t + DIGEST_INTERVAL_MS * 3);
    const digestsOnly = mesh.sent.length - afterFirstSync;
    expect(digestsOnly).toBeGreaterThan(0);
    expect(visibleWaypoints(b.orders)).toHaveLength(1);
    // Les digests sont petits : le filet ne coûte presque rien au repos.
    expect(mesh.sent.slice(afterFirstSync).every((s) => s.bytes < 20)).toBe(true);
  });
});
