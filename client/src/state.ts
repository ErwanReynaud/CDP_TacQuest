import type { MemberPublic, OrderMessage, RoomState } from '@tq/shared/protocol';
import { mergeOrder } from './crdt/orders';

export interface Session {
  roomCode: string;
  memberId: string;
  sessionToken: string;
  callsign: string;
  /** Conservé pour la compat protocole/serveur ; toujours 'GV' depuis la
   *  disparition du sélecteur de poste (les figurés hiérarchiques pourraient
   *  revenir un jour — le modèle serveur les gère encore). */
  role: string;
  isLeader: boolean;
}

export type ConnStatus = 'connected' | 'reconnecting' | 'offline';

export type BusEvent =
  | 'members' // roster ou attributs d'un membre modifiés
  | 'position' // une position a bougé (détail: memberId)
  | 'orders' // ordre reçu/ajouté (graphiques, waypoints…)
  | 'coordfmt' // format de coordonnées changé (MGRS/UTM/géo)
  | 'conn'
  | 'rejoined' // re-binding réussi après coupure
  | 'session-lost'; // room GC côté serveur → retour carte solo

type Listener = (detail?: unknown) => void;

const listeners = new Map<BusEvent, Set<Listener>>();

export const bus = {
  /** S'abonne à un événement. La fonction rendue se désabonne. */
  on(event: BusEvent, fn: Listener): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  },

  off(event: BusEvent, fn: Listener): void {
    listeners.get(event)?.delete(fn);
  },

  /**
   * Diffuse un événement. Chaque écouteur est isolé.
   *
   * Sans ce cloisonnement, un écouteur qui lève empêchait tous les suivants de
   * tourner et l'exception remontait dans l'émetteur — un paquet radio
   * malformé atteignant un écouteur d'interface aurait coupé toute la chaîne
   * de réception. Une erreur d'affichage ne doit pas faire tomber le transport.
   *
   * L'itération porte sur une copie : un écouteur peut s'abonner ou se
   * désabonner pendant la diffusion sans perturber le tour en cours.
   */
  emit(event: BusEvent, detail?: unknown): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(detail);
      } catch (err) {
        console.error(`[bus] écouteur ${event} en échec`, err);
      }
    }
  },
};

export const state = {
  session: null as Session | null,
  members: new Map<string, MemberPublic>(),
  orders: new Map<string, OrderMessage>(),
  conn: 'reconnecting' as ConnStatus,
};

const SESSION_KEY = 'tq-session';
const LAST_ROOM_KEY = 'tq-last-room';
const ROOM_HISTORY_KEY = 'tq-room-history';
const ROOM_HISTORY_MAX = 6;
const CALLSIGN_KEY = 'tq-callsign';

/** Indice de reconnexion : survit à clearSession (expiration), pas à un départ explicite. */
export interface LastRoom {
  roomCode: string;
  callsign: string;
}

/** Une entrée de l'historique des salles rejointes, plus récente en tête. */
export interface RoomHistoryEntry {
  roomCode: string;
  callsign: string;
  ts: number;
}

/**
 * Enregistre la session courante.
 *
 * Renvoie `false` si la persistance a échoué — quota dépassé, navigation
 * privée, stockage bloqué. La session reste alors valide **en mémoire** : on
 * entre bien dans la salle, mais elle ne survivra pas à un rechargement.
 *
 * Auparavant l'écriture n'était pas protégée : elle levait après avoir déjà
 * muté `state.session`, laissant une session à moitié établie — en mémoire
 * mais sans interface de salle — et l'appelant rapportait « Serveur
 * injoignable » pour une panne de stockage.
 *
 * localStorage et non sessionStorage : la PWA mobile est régulièrement tuée en
 * arrière-plan par l'OS, ce qui efface sessionStorage et fait retomber
 * l'utilisateur sur l'accueil. localStorage survit à la fermeture/relance ; le
 * re-binding serveur via sessionToken reprend la place dans la room.
 */
export function saveSession(s: Session): boolean {
  state.session = s;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    localStorage.setItem(
      LAST_ROOM_KEY,
      JSON.stringify({ roomCode: s.roomCode, callsign: s.callsign } satisfies LastRoom),
    );
  } catch {
    return false;
  }
  rememberRoom(s.roomCode, s.callsign);
  return true;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    state.session = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    state.session = null;
  }
  return state.session;
}

/** Efface la session active mais conserve l'indice de reconnexion (cf. loadLastRoom). */
export function clearSession(): void {
  state.session = null;
  state.members.clear();
  state.orders.clear();
  // Sans cela, la pastille restait « Connecté » une fois revenu en solo.
  setConn('reconnecting');
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* stockage indisponible : la session en mémoire est déjà effacée */
  }
}

/** Indicatif mémorisé pour pré-remplir la modale de salle aux prochains join. */
export function saveCallsign(callsign: string): void {
  try {
    localStorage.setItem(CALLSIGN_KEY, callsign);
  } catch {
    /* quota : tant pis */
  }
}

export function loadCallsign(): string | null {
  return localStorage.getItem(CALLSIGN_KEY);
}

/** Dernière room rejointe, pour pré-remplir la modale après une expiration serveur. */
export function loadLastRoom(): LastRoom | null {
  try {
    const raw = localStorage.getItem(LAST_ROOM_KEY);
    return raw ? (JSON.parse(raw) as LastRoom) : null;
  } catch {
    return null;
  }
}

/** Départ volontaire : on oublie tout, pas de pré-remplissage au retour. */
export function clearLastRoom(): void {
  localStorage.removeItem(LAST_ROOM_KEY);
}

/** Historique des salles rejointes (créées ou rejointes), plus récente en tête. */
export function loadRoomHistory(): RoomHistoryEntry[] {
  try {
    const raw = localStorage.getItem(ROOM_HISTORY_KEY);
    const list = raw ? (JSON.parse(raw) as RoomHistoryEntry[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveRoomHistory(list: RoomHistoryEntry[]): void {
  try {
    localStorage.setItem(ROOM_HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* quota : tant pis, l'historique est secondaire */
  }
}

/** Place la salle en tête (dédoublonnée par code), plafonnée à ROOM_HISTORY_MAX. */
export function rememberRoom(roomCode: string, callsign: string): void {
  const rest = loadRoomHistory().filter((e) => e.roomCode !== roomCode);
  saveRoomHistory([{ roomCode, callsign, ts: Date.now() }, ...rest].slice(0, ROOM_HISTORY_MAX));
}

/** Retire une salle de l'historique (oubli manuel, ou salle expirée). */
export function removeRoomFromHistory(roomCode: string): void {
  saveRoomHistory(loadRoomHistory().filter((e) => e.roomCode !== roomCode));
}

/**
 * Applique un snapshot serveur.
 *
 * Le roster est remplacé — le serveur en est la source de vérité — mais les
 * ordres sont **fusionnés**. Le serveur ne conserve que les
 * `MAX_RECENT_ORDERS` derniers : au-delà, les plus anciens tombent de son
 * tampon. Un remplacement effaçait alors chez le client qui se reconnecte des
 * figurés que les autres continuaient d'afficher, sans qu'aucune couche ne
 * s'en aperçoive. La fusion est idempotente et retient la version la plus
 * récente de chaque ordre.
 *
 * Le changement de salle reste un remplacement : sans quoi les figurés de la
 * salle précédente se déverseraient dans la nouvelle. `rs.code` distingue les
 * deux cas — une reconnexion porte le même code, un join un autre.
 */
export function applyRoomState(rs: RoomState): void {
  const sameRoom = state.session?.roomCode === rs.code;
  const selfId = state.session?.memberId;
  const selfBefore = selfId ? state.members.get(selfId) : undefined;

  state.members = new Map(rs.members.map((m) => [m.id, m]));
  // Le serveur n'écho pas nos propres positions : sans ce report, on
  // disparaissait du compteur et du tiroir jusqu'au fix suivant, soit 30 s.
  if (selfId && selfBefore?.lastPosition) {
    const fresh = state.members.get(selfId);
    if (fresh) fresh.lastPosition ??= selfBefore.lastPosition;
    else state.members.set(selfId, selfBefore);
  }

  if (!sameRoom) state.orders.clear();
  for (const o of rs.recentOrders) mergeOrder(state.orders, o);

  bus.emit('members');
  bus.emit('orders');
}

export function setConn(c: ConnStatus): void {
  if (state.conn === c) return;
  state.conn = c;
  bus.emit('conn', c);
}
