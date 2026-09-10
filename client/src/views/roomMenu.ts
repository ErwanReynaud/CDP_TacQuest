import { CALLSIGN_REGEX } from '@tq/shared/constants';
import { checkRoomCode, roomCodeErrorFr } from '@tq/shared/roomCode';
import type { ErrorCode } from '@tq/shared/protocol';
import type { Session } from '../state';
import {
  loadCallsign,
  loadLastRoom,
  loadRoomHistory,
  removeRoomFromHistory,
  saveCallsign,
  saveSession,
} from '../state';
import { createRoom, joinRoom, FIXED_ROLE } from '../transport';
import { enterRoomUi, toast } from './mapView';

// Les codes POST_TAKEN* ne peuvent plus arriver (tout le monde entre en 'GV',
// seul rôle sans unicité) mais le type ErrorCode les exige toujours.
const ERROR_FR: Record<ErrorCode, string> = {
  ROOM_NOT_FOUND: 'Salle introuvable. Vérifiez le code.',
  CALLSIGN_TAKEN: 'Cet indicatif est déjà utilisé dans la salle.',
  CALLSIGN_TAKEN_DISCONNECTED: 'Cet indicatif est utilisé mais déconnecté.',
  ROOM_FULL: 'La salle est pleine.',
  SERVER_FULL: 'Le serveur est saturé. Réessayez plus tard.',
  SESSION_INVALID: 'Session expirée.',
  INVALID_PAYLOAD: 'Saisie invalide.',
  POST_TAKEN: 'Ce poste est déjà occupé dans la salle.',
  POST_TAKEN_DISCONNECTED: 'Ce poste est occupé mais déconnecté.',
  RATE_LIMITED: 'Trop de salles créées récemment. Réessayez plus tard.',
  NOT_IN_ROOM: 'Vous n’êtes pas dans une salle.',
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface RoomMenuPrefill {
  code?: string;
  callsign?: string;
  error?: string;
}

export function openRoomMenu(prefill?: RoomMenuPrefill): void {
  const callsign = $<HTMLInputElement>('room-callsign');
  const code = $<HTMLInputElement>('room-code');
  // Indicatif mémorisé au dernier join réussi ; à défaut, celui de la dernière salle.
  if (!callsign.value) callsign.value = prefill?.callsign ?? loadCallsign() ?? loadLastRoom()?.callsign ?? '';
  if (prefill?.code) code.value = prefill.code;
  showError(prefill?.error ?? null);
  hideReplace();
  renderHistory();
  $('room-menu').hidden = false;
  if (!callsign.value) callsign.focus();
}

export function closeRoomMenu(): void {
  $('room-menu').hidden = true;
}

function showError(msg: string | null): void {
  const el = $('room-error');
  el.hidden = !msg;
  el.textContent = msg ?? '';
}

/** Cache la proposition de remplacement d'un indicatif déconnecté. */
function hideReplace(): void {
  $('btn-replace').hidden = true;
}

function setBusy(busy: boolean): void {
  // #btn-replace inclus : sans lui, un double appui lançait deux join
  // concurrents, dont le second reprenait l'indicatif que le premier venait
  // d'obtenir.
  for (const id of ['btn-room-create', 'btn-room-join', 'btn-replace']) {
    $(id).toggleAttribute('disabled', busy);
  }
}

function readCallsign(): string | null {
  const v = $<HTMLInputElement>('room-callsign').value.trim();
  if (!CALLSIGN_REGEX.test(v)) {
    showError('Indicatif invalide : 1 à 16 lettres, chiffres, espaces ou tirets.');
    return null;
  }
  return v;
}

export function initRoomMenu(): void {
  $('btn-room-create').addEventListener('click', async () => {
    const callsign = readCallsign();
    if (!callsign) return;
    setBusy(true);
    showError(null);

    // Le try ne couvre que l'appel réseau. Il englobait auparavant jusqu'à
    // enterRoomUi() : n'importe quelle exception du rendu carte s'affichait
    // alors comme « Serveur injoignable », envoyant l'utilisateur vérifier une
    // connexion qui marchait très bien.
    let res: Awaited<ReturnType<typeof createRoom>>;
    try {
      res = await createRoom(callsign);
    } catch {
      showError('Serveur injoignable. Vérifiez la connexion.');
      return;
    } finally {
      setBusy(false);
    }
    if (!res.ok) return showError(ERROR_FR[res.error]);

    enterRoom(
      {
        roomCode: res.roomCode,
        memberId: res.memberId,
        sessionToken: res.sessionToken,
        callsign,
        role: FIXED_ROLE,
        isLeader: true,
      },
      callsign,
    );
  });

  $('btn-room-join').addEventListener('click', () => void attemptJoin());
  $('btn-replace').addEventListener('click', () => void attemptJoin(true));
  const joinInput = $<HTMLInputElement>('room-code');
  joinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void attemptJoin();
  });
  // Toute édition rend la proposition de remplacement obsolète (autre indicatif/salle).
  joinInput.addEventListener('input', hideReplace);
  $<HTMLInputElement>('room-callsign').addEventListener('input', hideReplace);
  $('btn-room-cancel').addEventListener('click', closeRoomMenu);
  // Tap sur le fond assombri (hors carte) : referme la modale.
  $('room-menu').addEventListener('click', (e) => {
    if (e.target === $('room-menu')) closeRoomMenu();
  });
}

/**
 * Rejoint la salle dont le code est saisi (ou pré-rempli par un chip d'historique).
 * `replace` reprend l'indicatif d'un membre déconnecté, après confirmation.
 */
async function attemptJoin(replace = false): Promise<void> {
  const callsign = readCallsign();
  if (!callsign) return;
  // Valide longueur ET alphabet : l'alphabet exclut 0, O, 1, I et L parce que
  // le code se lit à la voix. Sans ça, un « oh » mal entendu partait au serveur
  // et revenait en ROOM_NOT_FOUND, envoyant chercher une salle disparue au lieu
  // d'une faute de frappe.
  const checked = checkRoomCode($<HTMLInputElement>('room-code').value);
  if (!checked.ok) return showError(roomCodeErrorFr(checked.error));
  const code = checked.code;
  setBusy(true);
  showError(null);
  hideReplace();

  // Comme pour la création : le try se limite à l'appel réseau.
  let res: Awaited<ReturnType<typeof joinRoom>>;
  try {
    res = await joinRoom(code, callsign, replace);
  } catch {
    showError('Serveur injoignable. Vérifiez la connexion.');
    return;
  } finally {
    setBusy(false);
  }

  if (!res.ok) {
    // Salle disparue (GC serveur) : on purge l'entrée d'historique périmée.
    if (res.error === 'ROOM_NOT_FOUND') {
      removeRoomFromHistory(code);
      renderHistory();
    }
    // Indicatif tenu par un membre déconnecté : on propose de le remplacer.
    if (res.error === 'CALLSIGN_TAKEN_DISCONNECTED') {
      showError(ERROR_FR[res.error]);
      const btn = $('btn-replace');
      btn.textContent = `Remplacer « ${callsign} » (déconnecté)`;
      btn.hidden = false;
      return;
    }
    return showError(ERROR_FR[res.error]);
  }

  enterRoom(
    {
      roomCode: res.roomCode,
      memberId: res.memberId,
      sessionToken: res.sessionToken,
      callsign,
      role: FIXED_ROLE,
      isLeader: false,
    },
    callsign,
  );
}

/**
 * Entrée effective en salle, commune à la création et au join.
 *
 * Hors de tout try : une exception d'interface doit remonter telle quelle,
 * pas se déguiser en panne réseau.
 */
function enterRoom(session: Session, callsign: string): void {
  const persisted = saveSession(session);
  saveCallsign(callsign);
  closeRoomMenu();
  enterRoomUi();
  if (!persisted) {
    // La session vit en mémoire : on entre bien dans la salle, mais elle ne
    // survivra pas à un rechargement. L'utilisateur doit le savoir avant de
    // partir sur le terrain, sans que ça l'empêche d'entrer.
    toast('Stockage indisponible : la salle sera perdue au rechargement.');
  }
}

/** Liste des salles récentes : un tap pré-remplit indicatif + code et rejoint. */
function renderHistory(): void {
  const container = $('room-history');
  const list = $('room-history-list');
  const history = loadRoomHistory();
  container.hidden = history.length === 0;
  list.replaceChildren();

  for (const entry of history) {
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'room-chip-main';
    const code = document.createElement('span');
    code.className = 'room-chip-code';
    code.textContent = entry.roomCode;
    const call = document.createElement('span');
    call.className = 'room-chip-call';
    call.textContent = entry.callsign;
    main.append(code, call);
    main.addEventListener('click', () => {
      $<HTMLInputElement>('room-callsign').value = entry.callsign;
      $<HTMLInputElement>('room-code').value = entry.roomCode;
      void attemptJoin();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'room-chip-remove';
    remove.setAttribute('aria-label', `Oublier la salle ${entry.roomCode}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      removeRoomFromHistory(entry.roomCode);
      renderHistory();
    });

    const chip = document.createElement('div');
    chip.className = 'room-chip';
    chip.append(main, remove);
    list.appendChild(chip);
  }
}
