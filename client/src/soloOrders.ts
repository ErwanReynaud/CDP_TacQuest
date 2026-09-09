import type { OrderMessage } from '@tq/shared/protocol';
import { bus, state } from './state';
import { sendOrder } from './socket';

// Figurés de la carte solo (hors salle) : appliqués localement et persistés en
// localStorage — ils survivent à la fermeture de l'app et reviennent à chaque
// retour en solo. À l'entrée en salle, on propose de les importer (ils sont
// alors transmis comme des ordres normaux et le stock solo est vidé).

/** authorId des ordres composés hors salle. */
export const SOLO_AUTHOR = 'solo';

const SOLO_ORDERS_KEY = 'tq-solo-orders';

export function loadSoloOrders(): OrderMessage[] {
  try {
    const raw = localStorage.getItem(SOLO_ORDERS_KEY);
    const list = raw ? (JSON.parse(raw) as OrderMessage[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    const list = [...state.orders.values()];
    if (list.length) localStorage.setItem(SOLO_ORDERS_KEY, JSON.stringify(list));
    else localStorage.removeItem(SOLO_ORDERS_KEY);
  } catch {
    /* quota : les figurés restent au moins en mémoire */
  }
}

/** authorId à poser sur un nouvel ordre, selon qu'on est en salle ou non. */
export function orderAuthor(): string {
  return state.session?.memberId ?? SOLO_AUTHOR;
}

/**
 * Émet un ordre : vers la salle si on y est (optimiste + file hors-ligne),
 * sinon appliqué à la carte solo et persisté. En solo, un `remove` supprime
 * physiquement sa cible (pas besoin de l'historique de suppression, et le
 * stock ne grossit pas indéfiniment).
 */
export function submitOrder(o: OrderMessage): void {
  if (state.session) return sendOrder(o);
  if (o.payload.kind === 'remove') state.orders.delete(o.payload.orderId);
  else state.orders.set(o.id, o);
  persist();
  bus.emit('orders');
}

/** Recharge les figurés solo dans l'état courant (boot solo, sortie de salle). */
export function restoreSoloOrders(): void {
  state.orders = new Map(loadSoloOrders().map((o) => [o.id, o]));
  bus.emit('orders');
}

/**
 * À l'entrée en salle : propose d'importer les figurés de la carte solo.
 * Importés = réémis à mon nom dans la salle (mêmes ids) puis retirés du stock
 * solo ; refusés = conservés, ils réapparaîtront au retour en solo.
 */
export function offerSoloImport(): void {
  const session = state.session;
  if (!session) return;
  const solo = loadSoloOrders();
  if (!solo.length) return;
  if (!confirm(`Importer ${solo.length} figuré(s) de votre carte solo dans la salle ?`)) return;
  for (const o of solo) sendOrder({ ...o, authorId: session.memberId });
  try {
    localStorage.removeItem(SOLO_ORDERS_KEY);
  } catch {
    /* ignore */
  }
}
