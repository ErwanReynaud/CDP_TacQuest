// Identifiants d'ordre courts.
//
// `OrderMessage.id` est aujourd'hui un uuid (36 o en chaîne, 16 o en binaire),
// et `remove`/`ack` en référencent un second : jusqu'à 32 o de pur identifiant
// par trame, soit 16 % du budget LoRa. On le remplace par (node, seq) = 6 o,
// dont 2 seulement passent sur le fil quand l'auteur est l'émetteur du paquet.
//
// Le serveur n'interprète jamais `id` (« enveloppe générique, jamais
// interprétée par le serveur », protocol.ts) : ce changement de format est
// purement client, et vaut donc aussi en mode serveur — ce qui permet à un nœud
// pont de relayer un ordre dans les deux sens sans table de correspondance.

/** Identifiant d'ordre : numéro de nœud Meshtastic + compteur d'auteur. */
export interface OrderId {
  /** Numéro de nœud Meshtastic (uint32) — champ `from` du paquet. */
  node: number;
  /** Compteur monotone de l'auteur (uint16, boucle à 65 536). */
  seq: number;
}

const ORDER_ID_RE = /^([0-9a-f]{8}):([0-9a-f]{4})$/;

/** Forme chaîne stable et débogable : « a4f2c810:003b ». */
export function formatOrderId(id: OrderId): string {
  return `${(id.node >>> 0).toString(16).padStart(8, '0')}:${(id.seq & 0xffff)
    .toString(16)
    .padStart(4, '0')}`;
}

/** Renvoie `null` sur un identifiant qui n'est pas au format mesh (uuid hérité). */
export function parseOrderId(s: string): OrderId | null {
  const m = ORDER_ID_RE.exec(s);
  if (!m) return null;
  return { node: parseInt(m[1]!, 16) >>> 0, seq: parseInt(m[2]!, 16) };
}

export function orderIdEquals(a: OrderId, b: OrderId): boolean {
  return a.node === b.node && a.seq === b.seq;
}

/**
 * Compteur de séquence par nœud. Persisté par l'appelant (localStorage) : un
 * redémarrage qui repartirait de 0 réémettrait des identifiants déjà utilisés,
 * et l'OR-Set confondrait deux ordres distincts.
 */
export class SeqCounter {
  private node: number;
  private next: number;

  constructor(node: number, start = 0) {
    this.node = node >>> 0;
    this.next = start & 0xffff;
  }

  /** Valeur à persister pour reprendre après redémarrage. */
  get value(): number {
    return this.next;
  }

  issue(): OrderId {
    const id: OrderId = { node: this.node, seq: this.next };
    this.next = (this.next + 1) & 0xffff;
    return id;
  }
}

/**
 * Comparaison de séquences en arithmétique circulaire (RFC 1982) : `seq`
 * reboucle à 65 536, donc `a > b` n'a de sens que dans une fenêtre d'un
 * demi-espace. Au-delà d'un demi-tour sans contact, la relation est indécidable
 * — cas couvert par le TTL des tombstones (24 h), bien plus court.
 */
export function seqNewer(a: number, b: number): boolean {
  return ((a - b) & 0xffff) !== 0 && ((a - b) & 0xffff) < 0x8000;
}
