// Façade de transport : la logique applicative passe par ici, et par ici seul.
//
// Elle expose exactement l'API que socket.ts offrait, pour que l'UI n'ait à
// changer que ses imports. Derrière, deux chemins peuvent être actifs
// simultanément :
//
//   - serveur (Socket.IO) quand une connexion réseau existe ;
//   - mesh LoRa quand un module Meshtastic est appairé en Bluetooth.
//
// Un ordre composé localement part sur **tous** les chemins actifs. Le doublon
// à l'arrivée est sans conséquence : mergeOrder est idempotent, et un ordre
// identifié par (nœud, séquence) est le même quel que soit le trajet.
//
// Ce qui n'est délibérément PAS fait : relayer sur LoRa les ordres reçus du
// serveur. Un nœud pontant deviendrait le répéteur de toute une salle, et
// l'airtime disponible ne le permet pas (cf. docs/mesh/protocol.md § 7).

import type { OrderMessage, Position } from '@tq/shared/protocol';
import { nodeToMemberId } from '@tq/shared/mesh/codec';
import { mergeOrder } from '../crdt/orders';
import type { Radio } from '../mesh/radio';
import { bus, state } from '../state';
import { MeshTransport } from './meshTransport';
import { adoptRadioNode, localNode } from './orderIds';
import * as server from '../socket';

let mesh: MeshTransport | null = null;

/**
 * Rattache une radio déjà connectée. Le numéro de nœud du module devient notre
 * espace d'identifiants : le codec élide l'auteur et le reconstruit depuis
 * l'émetteur du paquet, les deux doivent donc coïncider.
 */
export function attachMeshRadio(radio: Radio, log?: (m: string) => void): MeshTransport {
  detachMesh();
  if (radio.nodeNum !== null) adoptRadioNode(radio.nodeNum);
  radio.on('myNode', (nodeNum) => adoptRadioNode(nodeNum));
  mesh = new MeshTransport({ radio, log });
  return mesh;
}

export function detachMesh(): void {
  mesh?.stop();
  mesh = null;
}

export function meshTransport(): MeshTransport | null {
  return mesh;
}

/** Chemins actuellement utilisables. */
export function activeTransports(): ('server' | 'mesh')[] {
  const out: ('server' | 'mesh')[] = [];
  if (state.session) out.push('server');
  if (mesh?.online) out.push('mesh');
  return out;
}

/** Un ordre peut-il être partagé, ou reste-t-on sur la carte solo ? */
export function isShared(): boolean {
  return activeTransports().length > 0;
}

/** Identifiant d'auteur à poser sur un ordre, selon le chemin disponible. */
export function authorId(): string | null {
  if (state.session) return state.session.memberId;
  if (mesh) return nodeToMemberId(localNode());
  return null;
}

/**
 * Émet un ordre sur tous les chemins actifs.
 *
 * L'application locale optimiste et la file hors-ligne restent gérées par la
 * couche serveur : c'est elle qui persiste l'outbox et rejoue à la reconnexion.
 * Le mesh, lui, est sans file — un ordre qui ne passe pas est journalisé, car
 * réémettre en rafale sur un lien à 1 % de duty cycle aggraverait la situation.
 */
export function sendOrder(o: OrderMessage): void {
  if (state.session) {
    // La couche serveur applique l'ordre localement, le met en file et
    // l'envoie : on ne double pas son travail.
    server.sendOrder(o);
  } else if (mergeOrder(state.orders, o)) {
    // Mesh seul : sans session serveur, personne d'autre n'applique l'ordre
    // localement — sans cela, l'auteur ne verrait pas son propre figuré.
    bus.emit('orders');
  }
  void mesh?.sendOrder(o);
}

/** Émet une position sur tous les chemins actifs. */
export function sendPosition(p: Position): boolean {
  const viaServer = state.session ? server.sendPosition(p) : false;
  const viaMesh = mesh?.sendPosition(p) ?? false;
  return viaServer || viaMesh;
}

/** Publie notre indicatif sur le mesh (le serveur le connaît déjà par le join). */
export function announceCallsign(callsign: string): void {
  mesh?.announce(callsign);
}

// --- chemin serveur : réexporté tel quel ---
export const FIXED_ROLE = server.FIXED_ROLE;
export const createRoom = server.createRoom;
export const joinRoom = server.joinRoom;
export const connectForSession = server.connectForSession;
export const pendingOrderCount = server.pendingOrderCount;
export const restorePendingOrders = server.restorePendingOrders;

/** Quitte la salle serveur. Le mesh, lui, ne dépend d'aucune salle. */
export function leaveRoom(): void {
  server.leaveRoom();
}
