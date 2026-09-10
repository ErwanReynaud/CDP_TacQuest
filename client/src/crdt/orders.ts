// OR-Set add-wins des ordres (figurés, plots, missions, chat).
//
// Conception : docs/mesh/protocol.md § 6.2.
//
// L'état reste la Map<id, OrderMessage> existante — tombstones compris, comme
// aujourd'hui. Ce module fournit les trois opérations qui la rendent
// convergente : fusion d'un ordre entrant, résolution de ce qui est masqué, et
// compaction. La règle de masquage vit ici et nulle part ailleurs : dupliquée,
// elle dériverait, et deux nœuds afficheraient des cartes différentes.

import type { OrderMessage } from '@tq/shared/protocol';
import { TOMBSTONE_TTL_MS } from '@tq/shared/mesh/constants';

export type OrderStore = Map<string, OrderMessage>;

/**
 * Intègre un ordre reçu. Renvoie `true` s'il a modifié l'état — l'appelant
 * n'émet alors l'événement de bus que dans ce cas, ce qui évite de redessiner
 * la carte à chaque réémission.
 *
 * Idempotent par construction : une trame reçue deux fois (réémission d'un
 * pair, doublon mesh/serveur en mode mixte) ne change rien la seconde fois.
 * Un même id réémis avec un horodatage plus récent est une édition et
 * l'emporte ; plus ancien, il est ignoré — sans quoi une trame retardée
 * ressusciterait une version périmée d'un plot.
 */
export function mergeOrder(store: OrderStore, incoming: OrderMessage): boolean {
  const existing = store.get(incoming.id);
  if (existing && existing.ts >= incoming.ts) return false;
  store.set(incoming.id, incoming);
  return true;
}

/** Ce qui masque quoi, calculé une fois pour tout un rendu. */
export interface Suppression {
  /** id visé → horodatage du tombstone le plus récent le visant. */
  readonly removedAt: Map<string, number>;
  /** Horodatage du `clear` le plus récent ; `-1` si aucun. */
  readonly clearedBefore: number;
}

/** Dépouille les tombstones du magasin. */
export function suppression(store: OrderStore): Suppression {
  const removedAt = new Map<string, number>();
  let clearedBefore = -1;
  for (const o of store.values()) {
    if (o.payload.kind === 'remove') {
      const prev = removedAt.get(o.payload.orderId);
      // On garde le tombstone le plus récent : c'est lui qui décide face à une
      // édition postérieure.
      if (prev === undefined || o.ts > prev) removedAt.set(o.payload.orderId, o.ts);
    } else if (o.payload.kind === 'clear') {
      if (o.payload.beforeTs > clearedBefore) clearedBefore = o.payload.beforeTs;
    }
  }
  return { removedAt, clearedBefore };
}

/**
 * Un ordre est-il masqué ?
 *
 * **Add-wins** : une suppression ne masque que si elle est au moins aussi
 * récente que la version détenue. Une mise à jour postérieure du plot le fait
 * donc réapparaître, ce qui est le comportement voulu — l'inverse
 * (remove-wins) avalerait silencieusement une correction fraîche sur un plot
 * ENI que quelqu'un venait d'effacer. À horodatage strictement égal, la
 * suppression l'emporte : le cas ne se produit qu'à la granularité de
 * l'horloge, et il vaut mieux que « supprimer » juste après « créer » agisse.
 *
 * `clear` est un tombstone en masse borné : il ne masque que ce qui lui est
 * antérieur, donc n'avale jamais un ordre concurrent plus récent.
 */
export function isHidden(order: OrderMessage, s: Suppression): boolean {
  if (order.ts <= s.clearedBefore) return true;
  const removed = s.removedAt.get(order.id);
  return removed !== undefined && removed >= order.ts;
}

/** Types d'ordres qui ne sont pas des objets de carte mais des marqueurs. */
function isTombstone(o: OrderMessage): boolean {
  return o.payload.kind === 'remove' || o.payload.kind === 'clear';
}

/**
 * Purge les tombstones expirés, **et ce qu'ils masquaient**.
 *
 * Les deux ensemble, impérativement : retirer un tombstone seul ferait
 * réapparaître sa cible chez ce nœud alors qu'elle reste effacée chez les
 * autres, ce qui est exactement la divergence qu'on cherche à éviter.
 *
 * Au-delà du TTL, un nœud resté hors portée peut ressusciter un objet supprimé
 * pendant son absence : arbitrage assumé (§ 6.2), le prix de tombstones qui ne
 * grossissent pas indéfiniment sur un lien à 200 octets.
 *
 * Les `ack` et les messages de chat expirent aussi : ils sont transitoires et
 * représentent l'essentiel du volume sur une longue session.
 *
 * Renvoie le nombre d'entrées supprimées.
 */
export function compactOrders(store: OrderStore, now: number, ttlMs = TOMBSTONE_TTL_MS): number {
  const cutoff = now - ttlMs;
  const doomed = new Set<string>();

  for (const o of store.values()) {
    if (o.ts > cutoff) continue;
    if (o.payload.kind === 'remove') {
      doomed.add(o.id);
      doomed.add(o.payload.orderId);
    } else if (o.payload.kind === 'clear') {
      doomed.add(o.id);
      for (const target of store.values()) {
        if (target.ts <= o.payload.beforeTs) doomed.add(target.id);
      }
    } else if (o.payload.kind === 'ack' || o.payload.kind === 'text') {
      doomed.add(o.id);
    }
  }

  // Un tombstone encore valide protège sa cible : la retirer la ressusciterait.
  for (const o of store.values()) {
    if (o.ts > cutoff && isTombstone(o) && o.payload.kind === 'remove') {
      doomed.delete(o.payload.orderId);
    }
  }

  for (const id of doomed) store.delete(id);
  return doomed.size;
}
