import type { MemberPublic, OrderMessage, RoomState } from '@tq/shared/protocol';

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
  on(event: BusEvent, fn: Listener): void {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(fn);
  },
  emit(event: BusEvent, detail?: unknown): void {
    listeners.get(event)?.forEach((fn) => fn(detail));
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

export function saveSession(s: Session): void {
  state.session = s;
  // localStorage (et non sessionStorage) : la PWA mobile est régulièrement tuée
  // en arrière-plan par l'OS, ce qui efface sessionStorage et fait retomber
  // l'utilisateur sur l'accueil. localStorage survit à la fermeture/relance ;
  // le re-binding serveur via sessionToken reprend la place dans la room.
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  localStorage.setItem(
    LAST_ROOM_KEY,
    JSON.stringify({ roomCode: s.roomCode, callsign: s.callsign } satisfies LastRoom),
  );
  rememberRoom(s.roomCode, s.callsign);
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
  localStorage.removeItem(SESSION_KEY);
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

/** Applique un snapshot complet — réconciliation sans diff. */
export function applyRoomState(rs: RoomState): void {
  state.members = new Map(rs.members.map((m) => [m.id, m]));
  state.orders = new Map(rs.recentOrders.map((o) => [o.id, o]));
  bus.emit('members');
  bus.emit('orders');
}

export function setConn(c: ConnStatus): void {
  if (state.conn === c) return;
  state.conn = c;
  bus.emit('conn', c);
}
