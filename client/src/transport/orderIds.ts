// Attribution des identifiants d'ordre.
//
// Le codec mesh élide le nœud auteur : il le reconstruit depuis le champ `from`
// du paquet. Conséquence directe et contraignante : l'espace d'identifiants
// local **doit** être le numéro de nœud de notre propre module, sinon un
// `remove` émis ici ne désignerait pas le même ordre chez le destinataire.
//
// Hors mesh (mode serveur ou carte solo), aucun module n'est connecté : on
// utilise alors un identifiant aléatoire persisté, qui garantit l'unicité sans
// prétendre correspondre à une radio.

import { formatOrderId, parseOrderId, SeqCounter } from '@tq/shared/mesh/ids';

const NODE_KEY = 'tq-node-id';
const SEQ_KEY = 'tq-node-seq';

let counter: SeqCounter | null = null;
let node = 0;

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function write(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* quota ou mode privé : on continue en mémoire */
  }
}

function randomNode(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // 0 est réservé (diffusion Meshtastic) et ferait un identifiant ambigu.
  return buf[0]! === 0 ? 1 : buf[0]!;
}

function ensure(): SeqCounter {
  if (counter) return counter;
  node = readNumber(NODE_KEY) ?? randomNode();
  write(NODE_KEY, node);
  // Le compteur est persisté : repartir de 0 après un redémarrage réémettrait
  // des identifiants déjà utilisés, et l'OR-Set confondrait deux ordres
  // distincts — un `remove` effacerait alors le mauvais figuré.
  counter = new SeqCounter(node, readNumber(SEQ_KEY) ?? 0);
  return counter;
}

/** Numéro de nœud sous lequel nous signons nos ordres. */
export function localNode(): number {
  ensure();
  return node;
}

/**
 * Adopte le numéro de nœud du module qui vient d'être connecté.
 *
 * Les ordres déjà composés sous l'ancien identifiant le conservent : ils
 * restent valides côté serveur, mais ne peuvent pas partir sur LoRa, où leur
 * auteur serait mal reconstruit. `canSendOverMesh` les écarte explicitement.
 */
export function adoptRadioNode(nodeNum: number): void {
  ensure();
  if (node === nodeNum) return;
  node = nodeNum;
  write(NODE_KEY, node);
  // Compteur remis à sa valeur persistée pour ce nouveau nœud : on ne repart
  // pas de zéro à l'aveugle, mais on ne réutilise pas non plus la séquence de
  // l'ancien nœud, qui n'a rien à voir.
  counter = new SeqCounter(node, readNumber(`${SEQ_KEY}-${nodeNum}`) ?? 0);
}

/** Alloue un identifiant d'ordre neuf, au format `node:seq`. */
export function issueOrderId(): string {
  const c = ensure();
  const id = c.issue();
  write(SEQ_KEY, c.value);
  write(`${SEQ_KEY}-${node}`, c.value);
  return formatOrderId(id);
}

/**
 * Cet ordre peut-il être émis sur LoRa ?
 *
 * Faux pour un identifiant hérité (uuid des versions précédentes) et pour un
 * ordre composé sous un autre nœud — typiquement avant la connexion du module.
 */
export function canSendOverMesh(orderId: string): boolean {
  const parsed = parseOrderId(orderId);
  return parsed !== null && parsed.node === localNode();
}

/** Réinitialise l'état en mémoire. Réservé aux tests. */
export function resetOrderIds(): void {
  counter = null;
  node = 0;
}
