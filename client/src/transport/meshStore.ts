// Persistance locale des ordres reçus par la radio.
//
// En mode serveur, la durabilité vient du serveur : `room_state` rejoue
// l'historique à la reconnexion, et socket.ts persiste sa file d'envoi. En
// mesh il n'y a aucun serveur — si l'OS tue la PWA en arrière-plan, ce qui
// arrive régulièrement sur un téléphone en veille prolongée, tout ce que le
// poste avait reçu disparaît. Il faudrait alors attendre que l'anti-entropie
// le lui réémette, sur un lien à 200 octets.
//
// On écrit donc l'état des ordres dans localStorage, en différé pour ne pas
// sérialiser à chaque trame reçue pendant un rattrapage.

import type { OrderMessage } from '@tq/shared/protocol';
import { compactOrders, type OrderStore } from '../crdt/orders';

const KEY = 'tq-mesh-orders';

/** Délai d'écriture différée : une rafale de rattrapage n'écrit qu'une fois. */
const SAVE_DEBOUNCE_MS = 1_500;

/**
 * Plafond d'ordres conservés. À quelques centaines d'octets sérialisés pièce,
 * cela reste très en deçà du quota localStorage tout en couvrant largement une
 * mission. Au-delà, on garde les plus récents.
 */
const MAX_STORED = 500;

let timer: ReturnType<typeof setTimeout> | null = null;

function isOrder(v: unknown): v is OrderMessage {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<OrderMessage>;
  return (
    typeof o.id === 'string' &&
    typeof o.authorId === 'string' &&
    typeof o.ts === 'number' &&
    typeof o.payload === 'object' &&
    o.payload !== null
  );
}

/**
 * Relit les ordres persistés.
 *
 * Le contenu de localStorage est modifiable par l'utilisateur et survit aux
 * changements de version : chaque entrée est donc vérifiée, et une entrée
 * douteuse est ignorée plutôt que de contaminer l'état.
 */
export function loadMeshOrders(): OrderMessage[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isOrder) : [];
  } catch {
    return [];
  }
}

/** Écrit immédiatement. Compacte d'abord : inutile de persister des tombstones expirés. */
export function saveMeshOrders(orders: OrderStore, now = Date.now()): void {
  compactOrders(orders, now);
  let list = [...orders.values()];
  if (list.length > MAX_STORED) {
    list = list.sort((a, b) => a.ts - b.ts).slice(-MAX_STORED);
  }
  try {
    if (list.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* quota ou stockage bloqué : l'état reste en mémoire, c'est le principal */
  }
}

/** Programme une écriture différée ; les appels rapprochés se fondent en un seul. */
export function scheduleMeshSave(orders: OrderStore): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    saveMeshOrders(orders);
  }, SAVE_DEBOUNCE_MS);
}

/** Force l'écriture en attente. À appeler quand la page passe en arrière-plan. */
export function flushMeshSave(orders: OrderStore): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  saveMeshOrders(orders);
}

/** Oublie les ordres persistés (départ volontaire du mesh). */
export function clearMeshOrders(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
