import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkRoomCode, normalizeRoomCode, roomCodeErrorFr } from '../src/roomCode';

test('accepte un code valide', () => {
  const r = checkRoomCode('ABCDE');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.code, 'ABCDE');
});

test('normalise la casse, les espaces et les tirets', () => {
  // Un code lu à la radio est souvent noté « ab-cd e ».
  for (const raw of ['abcde', ' ABCDE ', 'ab-cd-e', 'AB CD E']) {
    assert.equal(normalizeRoomCode(raw), 'ABCDE', raw);
    assert.equal(checkRoomCode(raw).ok, true, raw);
  }
});

test('signale une longueur incorrecte avec le compte saisi', () => {
  const r = checkRoomCode('ABC');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.kind, 'length');
    assert.match(roomCodeErrorFr(r.error), /5 caractères \(3 saisis\)/);
  }
});

test('rejette les caractères exclus de l’alphabet', () => {
  // 0, O, 1, I et L sont absents pour éviter la confusion à la voix ; sans
  // cette garde, ils partaient au serveur et revenaient en ROOM_NOT_FOUND.
  for (const code of ['ABCD0', 'ABCDO', 'ABCD1', 'ABCDI', 'ABCDL']) {
    const r = checkRoomCode(code);
    assert.equal(r.ok, false, code);
    assert.equal(!r.ok && r.error.kind, 'charset', code);
  }
});

test('cite chaque caractère fautif une seule fois', () => {
  const r = checkRoomCode('OOIIL');
  assert.equal(r.ok, false);
  if (!r.ok && r.error.kind === 'charset') {
    assert.deepEqual(r.error.chars, ['O', 'I', 'L']);
    const msg = roomCodeErrorFr(r.error);
    assert.match(msg, /« O », « I », « L »/);
    // On ne propose pas de correction : 0 et O sont tous deux absents, rien ne
    // permet de deviner lequel l'opérateur voulait.
    assert.match(msg, /à la voix/);
  }
});

test('la longueur prime sur l’alphabet', () => {
  const r = checkRoomCode('OO');
  assert.equal(!r.ok && r.error.kind, 'length');
});
