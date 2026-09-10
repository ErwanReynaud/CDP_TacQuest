// Normalisation et validation d'un code de salle saisi à la main.
//
// L'alphabet exclut délibérément 0, O, 1, I et L : le code est destiné à être
// lu à la voix, à la radio. Sans validation côté client, un « oh » mal entendu
// partait au serveur et revenait en ROOM_NOT_FOUND générique — ce qui envoyait
// chercher une salle disparue au lieu d'une faute de frappe.

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './constants';

export type RoomCodeError =
  | { kind: 'length'; length: number }
  | { kind: 'charset'; chars: string[] };

export type RoomCodeCheck =
  | { ok: true; code: string }
  | { ok: false; error: RoomCodeError };

/** Majuscules, sans espaces ni tirets — on tolère « ab-cd e » à la saisie. */
export function normalizeRoomCode(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/** Normalise puis valide longueur et alphabet. */
export function checkRoomCode(raw: string): RoomCodeCheck {
  const code = normalizeRoomCode(raw);
  if (code.length !== ROOM_CODE_LENGTH) {
    return { ok: false, error: { kind: 'length', length: code.length } };
  }
  // Dédoublonné et ordonné comme dans la saisie : le message cite chaque
  // caractère fautif une seule fois.
  const bad: string[] = [];
  for (const c of code) {
    if (!ROOM_CODE_ALPHABET.includes(c) && !bad.includes(c)) bad.push(c);
  }
  return bad.length > 0 ? { ok: false, error: { kind: 'charset', chars: bad } } : { ok: true, code };
}

/**
 * Message en clair correspondant à une erreur de code.
 *
 * On nomme les caractères jamais employés plutôt que de proposer une
 * correction : `0` et `O` étant tous deux absents de l'alphabet, rien ne
 * permet de deviner lequel l'opérateur voulait dire.
 */
export function roomCodeErrorFr(error: RoomCodeError): string {
  if (error.kind === 'length') {
    return `Le code de salle fait ${ROOM_CODE_LENGTH} caractères (${error.length} saisi${
      error.length > 1 ? 's' : ''
    }).`;
  }
  const list = error.chars.map((c) => `« ${c} »`).join(', ');
  return `Le code ne contient jamais ${list} — ni les chiffres 0 et 1, ni les lettres O, I et L, pour éviter toute confusion à la voix.`;
}
