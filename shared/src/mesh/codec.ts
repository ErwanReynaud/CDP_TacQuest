// Codec binaire TacQuest ↔ Meshtastic (portnum privé).
//
// Spécification complète et budgets : docs/mesh/protocol.md
//
// Invariants tenus ici :
//  - toute trame encodée tient dans MESH_MAX_PAYLOAD (sinon MeshCodecError) ;
//  - encode(decode(x)) === x pour tout ordre encodable (cf. shared/test) ;
//  - `authorId` et le nœud auteur d'un identifiant ne passent jamais sur le fil
//    quand ils valent l'émetteur du paquet : ils viennent du champ `from`.

import type { GraphicStyle, LineEchelon, OrderMessage } from '../protocol';
import { ECHELONS, GEOM, MESH_PROTOCOL_VERSION, MISSION_UNKNOWN, OP } from './constants';
import { MeshCodecError, Reader, Writer } from './bytes';
import { type Anchor, decodeOffset, encodeOffset } from './geo';
import { colorToIndex, indexToColor, indexToSidc, sidcToIndex } from './palette';
import { formatOrderId, type OrderId, parseOrderId } from './ids';

/** Contexte partagé nécessaire pour coder ou décoder une trame. */
export interface MeshContext {
  /** Ancre de zone d'opération courante (opcode ANCHOR). */
  anchor: Anchor;
  /** Origine des horodatages, en secondes Unix (fixée à la création de la salle). */
  epochSec: number;
  /**
   * Catalogue des figurés de mission : l'index sur le fil est la position dans
   * ce tableau. Doit être identique sur tous les nœuds d'une même version.
   * Un index inconnu est rendu en ligne simple — comportement déjà spécifié par
   * `GraphicStyle.mission` dans protocol.ts.
   */
  missions: readonly string[];
}

/** Contexte de décodage : on connaît en plus l'émetteur du paquet. */
export interface DecodeContext extends MeshContext {
  /** Numéro de nœud Meshtastic de l'émetteur (champ `from` du paquet). */
  from: number;
}

/** Trames de contrôle : hors CRDT, elles ne portent pas d'ordre. */
export type ControlFrame =
  | { op: typeof OP.ANCHOR; anchor: Anchor; epochSec: number; originator: boolean }
  | { op: typeof OP.DIGEST; entries: { node: number; upto: number }[] }
  | { op: typeof OP.REQ; node: number; from: number; count: number }
  | { op: typeof OP.MEMBER; callsign: string; isLeader: boolean };

export type MeshFrame = { kind: 'order'; order: OrderMessage } | { kind: 'control'; frame: ControlFrame };

/** Identifiant de membre dérivé d'un numéro de nœud Meshtastic. */
export function nodeToMemberId(node: number): string {
  return (node >>> 0).toString(16).padStart(8, '0');
}

export function memberIdToNode(memberId: string): number | null {
  return /^[0-9a-f]{8}$/.test(memberId) ? parseInt(memberId, 16) >>> 0 : null;
}

const header = (op: number): number => ((MESH_PROTOCOL_VERSION & 0x0f) << 4) | (op & 0x0f);

// ---------------------------------------------------------------------------
// Géométrie
// ---------------------------------------------------------------------------

type Pt = [lng: number, lat: number]; // ordre GeoJSON

/**
 * Schéma fermé attendu par le codec pour `graphic.geojson`.
 *
 * `OrderPayload` garde `geojson: unknown` : le serveur relaie des ordres émis
 * par des clients quelconques, et orderFilter.ts valide déjà défensivement.
 * Le codec binaire, lui, a besoin d'un ensemble fermé — il valide donc à
 * l'entrée plutôt que de faire confiance à un transtypage.
 */
export interface LineStringFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

/** Valide et extrait les sommets ; renvoie `null` si la forme ne convient pas. */
function coordsOf(geojson: unknown): Pt[] | null {
  if (typeof geojson !== 'object' || geojson === null) return null;
  const geometry = (geojson as { geometry?: unknown }).geometry;
  if (typeof geometry !== 'object' || geometry === null) return null;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type !== 'LineString' || !Array.isArray(g.coordinates)) return null;
  const out: Pt[] = [];
  for (const c of g.coordinates) {
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
    out.push([c[0], c[1]]);
  }
  return out;
}

/** Détecte un rectangle à axes alignés (tolérance 1 m, soit le pas de quantification). */
function asRect(offs: { dE: number; dN: number }[]): { dE: number; dN: number; w: number; h: number } | null {
  const pts = offs.length === 5 && offs[0]!.dE === offs[4]!.dE && offs[0]!.dN === offs[4]!.dN
    ? offs.slice(0, 4)
    : offs;
  if (pts.length !== 4) return null;
  const [a, b, c, d] = pts as [typeof pts[0], typeof pts[0], typeof pts[0], typeof pts[0]];
  const near = (x: number, y: number): boolean => Math.abs(x - y) <= 1;
  // Parcours horaire ou antihoraire : côtés alternativement horizontaux/verticaux.
  const hv = near(a.dN, b.dN) && near(b.dE, c.dE) && near(c.dN, d.dN) && near(d.dE, a.dE);
  const vh = near(a.dE, b.dE) && near(b.dN, c.dN) && near(c.dE, d.dE) && near(d.dN, a.dN);
  if (!hv && !vh) return null;
  const w = c.dE - a.dE;
  const h = c.dN - a.dN;
  if (Math.abs(w) > 32767 || Math.abs(h) > 32767) return null;
  return { dE: a.dE, dN: a.dN, w, h };
}

function writeGeometry(w: Writer, geom: number, offs: { dE: number; dN: number }[]): void {
  if (geom === GEOM.RECT) {
    const r = asRect(offs)!;
    w.i16(r.dE).i16(r.dN).i16(r.w).i16(r.h);
    return;
  }
  w.u8(offs.length);
  w.i16(offs[0]!.dE).i16(offs[0]!.dN);
  // Chaînage : chaque sommet est un delta zigzag du précédent. Un tracé fin
  // (sommets à quelques dizaines de mètres) coûte alors 2 o par point.
  for (let i = 1; i < offs.length; i++) {
    w.zigzag(offs[i]!.dE - offs[i - 1]!.dE).zigzag(offs[i]!.dN - offs[i - 1]!.dN);
  }
}

function readGeometry(r: Reader, geom: number): { dE: number; dN: number }[] {
  if (geom === GEOM.RECT) {
    const dE = r.i16();
    const dN = r.i16();
    const w = r.i16();
    const h = r.i16();
    // Rendu fermé (5 sommets) : c'est ce qu'attend le calque polygone.
    return [
      { dE, dN }, { dE: dE + w, dN }, { dE: dE + w, dN: dN + h }, { dE, dN: dN + h }, { dE, dN },
    ];
  }
  const n = r.u8();
  if (n === 0) throw new MeshCodecError('géométrie vide');
  const out: { dE: number; dN: number }[] = [{ dE: r.i16(), dN: r.i16() }];
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1]!;
    out.push({ dE: prev.dE + r.zigzag(), dN: prev.dN + r.zigzag() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encodage
// ---------------------------------------------------------------------------

function writeOrderHeader(w: Writer, op: number, id: OrderId, ts: number, epochSec: number): void {
  w.u8(header(op)).u16(id.seq);
  // Zigzag : tolère une dérive d'horloge qui placerait un ordre avant l'époque
  // de la salle, sans coûter d'octet supplémentaire sur la plage utile.
  w.zigzag(Math.round(ts / 1000) - epochSec);
}

function writeRef(w: Writer, target: OrderId, selfNode: number): void {
  const isSelf = target.node === selfNode;
  w.u8(isSelf ? 1 : 0);
  if (!isSelf) w.u32(target.node);
  w.u16(target.seq);
}

/**
 * Encode un ordre applicatif en trame binaire.
 *
 * `order.id` doit être au format mesh (node:seq) : un uuid hérité est refusé,
 * car sa forme longue ne tient pas dans le budget.
 */
export function encodeOrder(order: OrderMessage, ctx: MeshContext): Uint8Array {
  const id = parseOrderId(order.id);
  if (!id) throw new MeshCodecError(`identifiant non-mesh : ${order.id}`);
  const w = new Writer();
  const p = order.payload;

  switch (p.kind) {
    case 'waypoint': {
      const off = encodeOffset(ctx.anchor, p.lat, p.lng);
      if (!off) throw new MeshCodecError('point hors enveloppe de l’ancre');
      const sidcIdx = p.sidc != null ? sidcToIndex(p.sidc) : null;
      const hasColor = p.color != null;
      writeOrderHeader(w, OP.WAYPOINT, id, order.ts, ctx.epochSec);
      w.u8((hasColor ? 0x80 : 0) | (sidcIdx !== null ? 0x40 : 0) | (hasColor ? colorToIndex(p.color!) : 0));
      w.i16(off.dE).i16(off.dN);
      if (sidcIdx !== null) w.u8(sidcIdx);
      w.str(p.name, 48);
      break;
    }
    case 'graphic': {
      const coords = coordsOf(p.geojson);
      if (!coords || coords.length < 2) {
        throw new MeshCodecError('géométrie graphique absente, malformée ou trop courte');
      }
      const offs = coords.map(([lng, lat]) => {
        const o = encodeOffset(ctx.anchor, lat, lng);
        if (!o) throw new MeshCodecError('sommet hors enveloppe de l’ancre');
        return o;
      });
      const st: GraphicStyle = p.style ?? {};
      const missionIdx = st.mission != null ? ctx.missions.indexOf(st.mission) : -1;
      const echIdx = st.echelon != null ? ECHELONS.indexOf(st.echelon) : -1;
      const geom = st.polygon && asRect(offs) ? GEOM.RECT : st.polygon ? GEOM.POLY : GEOM.LINE;

      writeOrderHeader(w, OP.GRAPHIC, id, order.ts, ctx.epochSec);
      w.u8(
        (geom & 0x03) |
          (st.arrow ? 0x04 : 0) |
          (st.polygon ? 0x08 : 0) |
          (st.label != null ? 0x10 : 0) |
          (st.mission != null ? 0x20 : 0) |
          (echIdx >= 0 ? 0x40 : 0),
      );
      w.u8((colorToIndex(st.color ?? '#e8d44d') & 0x0f) | ((Math.min(15, st.weight ?? 4) & 0x0f) << 4));
      writeGeometry(w, geom, offs);
      // Une mission hors catalogue part en MISSION_UNKNOWN : le destinataire la
      // rend en ligne simple plutôt que de rejeter tout l'ordre.
      if (st.mission != null) w.u8(missionIdx >= 0 ? missionIdx : MISSION_UNKNOWN);
      if (echIdx >= 0) w.u8(echIdx);
      if (st.label != null) w.str(st.label, 32);
      break;
    }
    case 'remove':
    case 'ack': {
      const target = parseOrderId(p.orderId);
      if (!target) throw new MeshCodecError(`référence non-mesh : ${p.orderId}`);
      writeOrderHeader(w, p.kind === 'remove' ? OP.REMOVE : OP.ACK, id, order.ts, ctx.epochSec);
      writeRef(w, target, id.node);
      break;
    }
    case 'text': {
      writeOrderHeader(w, OP.TEXT, id, order.ts, ctx.epochSec);
      w.str(p.body, 180);
      break;
    }
    case 'clear': {
      writeOrderHeader(w, OP.CLEAR_ALL, id, order.ts, ctx.epochSec);
      w.zigzag(Math.round(p.beforeTs / 1000) - ctx.epochSec);
      break;
    }
    default: {
      const never: never = p;
      throw new MeshCodecError(`ordre non encodable : ${JSON.stringify(never)}`);
    }
  }
  return w.bytes();
}

// ---------------------------------------------------------------------------
// Décodage
// ---------------------------------------------------------------------------

function readRef(r: Reader, selfNode: number): OrderId {
  const isSelf = (r.u8() & 1) === 1;
  const node = isSelf ? selfNode : r.u32();
  return { node, seq: r.u16() };
}

export function decodeFrame(bytes: Uint8Array, ctx: DecodeContext): MeshFrame {
  const r = new Reader(bytes);
  const b0 = r.u8();
  const version = (b0 >> 4) & 0x0f;
  const op = b0 & 0x0f;
  if (version !== MESH_PROTOCOL_VERSION) {
    throw new MeshCodecError(`version de protocole ${version} non gérée (attendu ${MESH_PROTOCOL_VERSION})`);
  }

  // --- trames de contrôle ---
  if (op === OP.ANCHOR) {
    const latE7 = r.i32();
    const lngE7 = r.i32();
    const epochSec = r.u32();
    const flags = r.u8();
    return {
      kind: 'control',
      frame: {
        op: OP.ANCHOR,
        anchor: { lat: latE7 / 1e7, lng: lngE7 / 1e7 },
        epochSec,
        originator: (flags & 1) === 1,
      },
    };
  }
  if (op === OP.DIGEST) {
    const n = r.u8();
    const entries: { node: number; upto: number }[] = [];
    for (let i = 0; i < n; i++) entries.push({ node: r.u32(), upto: r.u16() });
    return { kind: 'control', frame: { op: OP.DIGEST, entries } };
  }
  if (op === OP.REQ) {
    return { kind: 'control', frame: { op: OP.REQ, node: r.u32(), from: r.u16(), count: r.u8() } };
  }
  if (op === OP.MEMBER) {
    const flags = r.u8();
    return { kind: 'control', frame: { op: OP.MEMBER, isLeader: (flags & 1) === 1, callsign: r.str() } };
  }

  // --- trames porteuses d'ordre ---
  const id: OrderId = { node: ctx.from, seq: r.u16() };
  const ts = (ctx.epochSec + r.zigzag()) * 1000;
  const base = { id: formatOrderId(id), authorId: nodeToMemberId(ctx.from), ts };

  switch (op) {
    case OP.WAYPOINT: {
      const attrs = r.u8();
      const { lat, lng } = decodeOffset(ctx.anchor, { dE: r.i16(), dN: r.i16() });
      const sidc = (attrs & 0x40) !== 0 ? indexToSidc(r.u8()) : undefined;
      const name = r.str();
      return {
        kind: 'order',
        order: {
          ...base,
          kind: 'waypoint',
          payload: {
            kind: 'waypoint',
            name,
            lat,
            lng,
            ...((attrs & 0x80) !== 0 ? { color: indexToColor(attrs & 0x0f) } : {}),
            ...(sidc != null ? { sidc } : {}),
          },
        },
      };
    }
    case OP.GRAPHIC: {
      const gflags = r.u8();
      const sByte = r.u8();
      const geom = gflags & 0x03;
      const offs = readGeometry(r, geom);
      const style: GraphicStyle = {
        color: indexToColor(sByte & 0x0f),
        weight: (sByte >> 4) & 0x0f,
      };
      if ((gflags & 0x04) !== 0) style.arrow = true;
      if ((gflags & 0x08) !== 0) style.polygon = true;
      if ((gflags & 0x20) !== 0) {
        const idx = r.u8();
        const name = ctx.missions[idx];
        // Index inconnu : on laisse `mission` absent → rendu en ligne simple.
        if (name != null) style.mission = name;
      }
      if ((gflags & 0x40) !== 0) style.echelon = ECHELONS[r.u8()] as LineEchelon | undefined;
      if ((gflags & 0x10) !== 0) style.label = r.str();
      return {
        kind: 'order',
        order: {
          ...base,
          kind: 'graphic',
          payload: {
            kind: 'graphic',
            geojson: {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: offs.map((o) => {
                  const { lat, lng } = decodeOffset(ctx.anchor, o);
                  return [lng, lat] as Pt;
                }),
              },
            },
            style,
          },
        },
      };
    }
    case OP.REMOVE:
    case OP.ACK: {
      const kind = op === OP.REMOVE ? 'remove' : 'ack';
      const orderId = formatOrderId(readRef(r, ctx.from));
      return { kind: 'order', order: { ...base, kind, payload: { kind, orderId } } };
    }
    case OP.TEXT: {
      const body = r.str();
      return { kind: 'order', order: { ...base, kind: 'text', payload: { kind: 'text', body } } };
    }
    case OP.CLEAR_ALL: {
      const beforeTs = (ctx.epochSec + r.zigzag()) * 1000;
      return { kind: 'order', order: { ...base, kind: 'clear', payload: { kind: 'clear', beforeTs } } };
    }
    default:
      throw new MeshCodecError(`opcode inconnu : 0x${op.toString(16)}`);
  }
}

// ---------------------------------------------------------------------------
// Trames de contrôle : encodage
// ---------------------------------------------------------------------------

export function encodeAnchor(anchor: Anchor, epochSec: number, originator = false): Uint8Array {
  return new Writer()
    .u8(header(OP.ANCHOR))
    .i32(Math.round(anchor.lat * 1e7))
    .i32(Math.round(anchor.lng * 1e7))
    .u32(epochSec)
    .u8(originator ? 1 : 0)
    .bytes();
}

export function encodeDigest(entries: readonly { node: number; upto: number }[]): Uint8Array {
  const w = new Writer().u8(header(OP.DIGEST)).u8(entries.length);
  for (const e of entries) w.u32(e.node).u16(e.upto);
  return w.bytes();
}

export function encodeReq(node: number, from: number, count: number): Uint8Array {
  return new Writer().u8(header(OP.REQ)).u32(node).u16(from).u8(count).bytes();
}

export function encodeMember(callsign: string, isLeader: boolean): Uint8Array {
  return new Writer().u8(header(OP.MEMBER)).u8(isLeader ? 1 : 0).str(callsign, 16).bytes();
}

// ---------------------------------------------------------------------------
// Ajustement au budget
// ---------------------------------------------------------------------------

/**
 * Aire du triangle formé par trois sommets consécutifs (critère Visvalingam).
 * Sert à choisir le sommet dont le retrait déforme le moins le tracé.
 */
function triangleArea(a: Pt, b: Pt, c: Pt): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

/** Retire le sommet intérieur le moins significatif. Les extrémités sont préservées
 *  (une box est une LineString fermée : perdre le premier ou le dernier sommet
 *  l'ouvrirait). */
function dropLeastSignificant(pts: Pt[]): Pt[] {
  if (pts.length <= 3) return pts;
  let best = 1;
  let bestArea = Infinity;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = triangleArea(pts[i - 1]!, pts[i]!, pts[i + 1]!);
    if (a < bestArea) {
      bestArea = a;
      best = i;
    }
  }
  return [...pts.slice(0, best), ...pts.slice(best + 1)];
}

export interface FittedFrame {
  bytes: Uint8Array;
  /** Nombre de sommets sacrifiés pour tenir dans le budget (0 si intact). */
  droppedPoints: number;
}

/**
 * Encode un ordre en le simplifiant juste ce qu'il faut pour tenir dans
 * MESH_MAX_PAYLOAD.
 *
 * Un tracé libre à 40 sommets dépasse le budget d'une trame LoRa : plutôt que
 * de rejeter l'ordre (le figuré n'arriverait jamais) ou de le fragmenter (deux
 * fois l'airtime, et un tracé à moitié reçu), on décime les sommets les moins
 * significatifs. Le tracé arrive légèrement lissé, ce qui est le bon compromis
 * pour un figuré tactique.
 *
 * C'est cette variante que la couche transport doit appeler ; `encodeOrder`
 * reste stricte pour que les tests détectent tout dépassement silencieux.
 */
export function encodeOrderFitted(order: OrderMessage, ctx: MeshContext): FittedFrame {
  try {
    return { bytes: encodeOrder(order, ctx), droppedPoints: 0 };
  } catch (err) {
    if (!(err instanceof MeshCodecError) || order.payload.kind !== 'graphic') throw err;
  }

  const p = order.payload as Extract<OrderMessage['payload'], { kind: 'graphic' }>;
  const coords = coordsOf(p.geojson);
  if (!coords) throw new MeshCodecError('géométrie graphique malformée');
  let pts = coords;
  const initial = pts.length;

  while (pts.length > 2) {
    const next = dropLeastSignificant(pts);
    if (next.length === pts.length) break; // plus rien à retirer
    pts = next;
    const candidate: OrderMessage = {
      ...order,
      payload: {
        ...p,
        geojson: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: pts },
        } satisfies LineStringFeature,
      },
    };
    try {
      return { bytes: encodeOrder(candidate, ctx), droppedPoints: initial - pts.length };
    } catch (err) {
      if (!(err instanceof MeshCodecError)) throw err;
    }
  }
  // Deux sommets et un libellé plafonné tiennent toujours : si on arrive ici,
  // c'est que la cause du dépassement n'est pas la géométrie.
  throw new MeshCodecError('ordre inencodable même réduit à deux sommets');
}
