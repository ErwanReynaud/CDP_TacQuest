import { io, type Socket } from 'socket.io-client';
import { POSITION_INTERVAL_MS } from '@tq/shared/constants';
import type {
  Ack,
  ClientToServerEvents,
  JoinedRoom,
  OrderMessage,
  Position,
  RoomState,
  ServerToClientEvents,
} from '@tq/shared/protocol';
import { applyRoomState, bus, clearLastRoom, clearSession, setConn, state } from './state';

const ACK_TIMEOUT_MS = 10_000;

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  autoConnect: false,
  reconnectionDelayMax: 5_000,
});

// --- événements room → état local ---

socket.on('room_state', applyRoomState);

socket.on('member_joined', ({ member }) => {
  state.members.set(member.id, member);
  bus.emit('members');
});

socket.on('member_left', ({ memberId }) => {
  state.members.delete(memberId);
  bus.emit('members');
});

// Réception des positions des coéquipiers : on NE les applique PAS à chaque
// message. Les téléphones échantillonnant toutes les 30 s mais désynchronisés,
// appliquer chaque mise à jour réveillerait le rendu de la carte en continu
// (coûteux en batterie). On bufferise la dernière position connue par membre et
// on applique le lot toutes les 30 s — même cadence que nos propres envois.
const positionBuffer = new Map<string, Position>();
let positionFlushTimer: ReturnType<typeof setInterval> | null = null;

socket.on('member_position', ({ memberId, position }) => {
  if (!state.members.has(memberId)) return;
  positionBuffer.set(memberId, position); // n'en garde que la plus récente
});

function flushPositions(): void {
  for (const [memberId, position] of positionBuffer) {
    const m = state.members.get(memberId);
    if (!m) continue;
    m.lastPosition = position;
    m.lastSeen = Date.now();
    bus.emit('position', memberId);
  }
  positionBuffer.clear();
}

function startPositionFlush(): void {
  positionFlushTimer ??= setInterval(flushPositions, POSITION_INTERVAL_MS);
}

function stopPositionFlush(): void {
  if (positionFlushTimer) {
    clearInterval(positionFlushTimer);
    positionFlushTimer = null;
  }
  positionBuffer.clear();
}

socket.on('member_updated', ({ memberId, role, connected }) => {
  const m = state.members.get(memberId);
  if (!m) return;
  if (role !== undefined) m.role = role;
  if (connected !== undefined) {
    m.connected = connected;
    m.lastSeen = Date.now();
  }
  bus.emit('members');
});

socket.on('order', (o) => {
  state.orders.set(o.id, o);
  bus.emit('orders');
});

socket.on('room_closed', ({ reason }) => {
  clearSession();
  const msg =
    reason === 'kicked' ? 'Tu as été exclu de la salle.'
    : reason === 'closed' ? 'La salle a été fermée par l’administrateur.'
    : 'La salle a expiré.';
  bus.emit('session-lost', msg);
});

// --- cycle de connexion ---

socket.on('connect', () => {
  startPositionFlush();
  if (state.session) void rejoin();
  else setConn('connected');
});

socket.on('disconnect', () => {
  stopPositionFlush();
  setConn('reconnecting');
});
socket.io.on('reconnect_failed', () => setConn('offline'));

async function rejoin(): Promise<void> {
  const s = state.session;
  if (!s) return;
  try {
    const res = await socket
      .timeout(ACK_TIMEOUT_MS)
      .emitWithAck('rejoin_room', {
        roomCode: s.roomCode,
        memberId: s.memberId,
        sessionToken: s.sessionToken,
      });
    if (res.ok) {
      applyRoomState(res.roomState);
      // Le snapshot serveur ignore les ordres composés hors-ligne :
      // on les ré-applique puis on vide la file vers le serveur.
      mergeOutbox();
      setConn('connected');
      bus.emit('rejoined');
      void flushOutbox();
    } else {
      // Room GC côté serveur : la session ne reviendra pas.
      clearSession();
      bus.emit('session-lost', 'La salle n’existe plus.');
    }
  } catch {
    // Timeout d'ack : Socket.IO va retenter la connexion, on réessaiera.
  }
}

function ensureConnected(): void {
  if (!socket.connected) socket.connect();
}

// Depuis l'abandon du sélecteur de poste, tout le monde entre en 'GV' : c'est
// le seul rôle du protocole exempt d'unicité (POST_TAKEN ne peut plus arriver)
// et le serveur reste inchangé — le champ `role` survit pour un retour futur
// des figurés hiérarchiques.
export const FIXED_ROLE = 'GV';

export async function createRoom(callsign: string): Promise<Ack<JoinedRoom>> {
  ensureConnected();
  const res = await socket
    .timeout(ACK_TIMEOUT_MS)
    .emitWithAck('create_room', { callsign, role: FIXED_ROLE });
  // Applique le snapshot initial : sinon les membres déjà présents (le chef
  // pour un subordonné qui rejoint après lui) ne seraient jamais affichés.
  if (res.ok) applyRoomState(res.roomState);
  return res;
}

export async function joinRoom(
  roomCode: string,
  callsign: string,
  replace = false,
): Promise<Ack<JoinedRoom>> {
  ensureConnected();
  const res = await socket
    .timeout(ACK_TIMEOUT_MS)
    .emitWithAck('join_room', { roomCode, callsign, role: FIXED_ROLE, replace });
  if (res.ok) applyRoomState(res.roomState);
  return res;
}

export function connectForSession(): void {
  ensureConnected();
}

export function sendPosition(p: Position): boolean {
  if (!socket.connected || !state.session) return false;
  socket.emit('position_update', p);
  return true;
}

// --- ordres : application optimiste + file d'attente hors-ligne ---
// Un ordre s'applique localement tout de suite (visible même sans réseau) et
// part dans une file. La file est persistée pour survivre à un rechargement
// hors-ligne, et vidée vers le serveur à la (re)connexion.

const OUTBOX_KEY = 'tq-outbox';
let outbox: OrderMessage[] = loadOutbox();
let flushing = false;

function loadOutbox(): OrderMessage[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as OrderMessage[]) : [];
  } catch {
    return [];
  }
}

function persistOutbox(): void {
  try {
    // localStorage comme la session : les ordres en attente doivent survivre à
    // une mise en arrière-plan prolongée de la PWA, pas seulement à un reload.
    if (outbox.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch {
    /* quota : tant pis, la file reste en mémoire */
  }
}

/** Ré-applique les ordres en attente par-dessus un snapshot serveur frais. */
function mergeOutbox(): void {
  for (const o of outbox) state.orders.set(o.id, o);
  if (outbox.length) bus.emit('orders');
}

/** Application optimiste : visible immédiatement, synchronisé dès que possible. */
export function sendOrder(o: OrderMessage): void {
  if (!state.session) return;
  state.orders.set(o.id, o);
  bus.emit('orders');
  outbox.push(o);
  persistOutbox();
  void flushOutbox();
}

async function flushOutbox(): Promise<void> {
  if (flushing || !socket.connected || !state.session) return;
  flushing = true;
  try {
    while (outbox.length > 0) {
      const o = outbox[0]!;
      try {
        const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck('send_order', o);
        // Succès, ou rejet définitif (payload invalide) : on retire de la file.
        // Un rejet réseau (timeout) lève et sera retenté à la prochaine connexion.
        if (!res.ok && res.error !== 'INVALID_PAYLOAD' && res.error !== 'NOT_IN_ROOM') {
          return; // erreur transitoire : on garde et on réessaiera
        }
        outbox.shift();
        persistOutbox();
        bus.emit('orders'); // rafraîchit l'indicateur d'éléments en attente
      } catch {
        return; // déconnexion / timeout : la file est conservée
      }
    }
  } finally {
    flushing = false;
  }
}

export function pendingOrderCount(): number {
  return outbox.length;
}

/** Ré-affiche les ordres en attente après un rechargement (état en mémoire vidé). */
export function restorePendingOrders(): void {
  mergeOutbox();
}

export function leaveRoom(): void {
  if (socket.connected) socket.emit('leave_room');
  clearSession();
  clearLastRoom(); // départ volontaire : pas de pré-remplissage au retour
  socket.disconnect();
}

export type { RoomState };
