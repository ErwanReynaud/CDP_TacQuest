// E2E du protocole : deux clients Socket.IO contre un serveur local.
// Usage : npm start (dans un autre terminal), puis `node scripts/e2e.mjs`.
import { io } from 'socket.io-client';

const URL = process.env.TQ_URL ?? 'http://localhost:3000';
const SIDC = 'SFGPUCI----';
let failures = 0;

function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

function connect() {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

const emitAck = (s, ev, p) => s.timeout(5000).emitWithAck(ev, p);
const once = (s, ev, ms = 5000) =>
  new Promise((resolve, reject) => {
    s.once(ev, resolve);
    setTimeout(() => reject(new Error(`timeout en attente de ${ev}`)), ms);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- scénario ---
const leader = await connect();

const created = await emitAck(leader, 'create_room', { callsign: 'Alpha 1', sidc: SIDC });
check('create_room ok', created.ok);
check('code à 6 caractères', created.ok && created.roomCode.length === 6);
const code = created.roomCode;

// join invalide
const badJoin = await emitAck(leader, 'join_room', { roomCode: 'ZZZZ22', callsign: 'X', sidc: SIDC });
check('join code inconnu → ROOM_NOT_FOUND', !badJoin.ok && badJoin.error === 'ROOM_NOT_FOUND');

// deuxième membre
const member = await connect();
const joinedEvent = once(leader, 'member_joined');
const joined = await emitAck(member, 'join_room', { roomCode: code, callsign: 'Bravo 2', sidc: SIDC });
check('join_room ok', joined.ok);
check('roomState contient 2 membres', joined.ok && joined.roomState.members.length === 2);
check('le chef reçoit member_joined', Boolean(await joinedEvent));

// positions
const posEvent = once(leader, 'member_position');
member.emit('position_update', { lat: 45.1885, lng: 5.7245, accuracy: 8, heading: 90, speed: 1.2, ts: Date.now() });
const pos = await posEvent;
check('position relayée au chef', pos.memberId === joined.memberId && pos.position.lat === 45.1885);

// throttle serveur : 2e fix immédiat ignoré
let throttled = true;
leader.once('member_position', () => (throttled = false));
member.emit('position_update', { lat: 45.1886, lng: 5.7246, accuracy: 8, heading: 90, speed: 1.2, ts: Date.now() });
await sleep(400);
check('fix < 900 ms rejeté (throttle)', throttled);

// changement de symbole
const updEvent = once(leader, 'member_updated');
member.emit('update_symbol', { sidc: 'SFGPUCR----' });
const upd = await updEvent;
check('update_symbol propagé', upd.sidc === 'SFGPUCR----');

// reconnexion : coupure + rejoin avec sessionToken
const discEvent = once(leader, 'member_updated');
member.disconnect();
const disc = await discEvent;
check('déconnexion vue par le chef (connected:false)', disc.connected === false);

const member2 = await connect();
const rejoined = await emitAck(member2, 'rejoin_room', {
  roomCode: code,
  memberId: joined.memberId,
  sessionToken: joined.sessionToken,
});
check('rejoin avec token valide ok', rejoined.ok);
check('lastPosition conservée pour les retardataires',
  rejoined.ok && rejoined.roomState.members.find((m) => m.id === joined.memberId)?.lastPosition?.lat === 45.1885);

const badRejoin = await emitAck(member2, 'rejoin_room', { roomCode: code, memberId: joined.memberId, sessionToken: 'faux' });
check('rejoin avec mauvais token → SESSION_INVALID', !badRejoin.ok && badRejoin.error === 'SESSION_INVALID');

// ordre (protocole phase 5, relayé sans interprétation)
const orderEvent = once(leader, 'order');
const orderAck = await emitAck(member2, 'send_order', {
  id: 'o-1', authorId: joined.memberId, ts: Date.now(),
  kind: 'waypoint',
  payload: { kind: 'waypoint', name: 'PT ALPHA', lat: 45.19, lng: 5.72 },
});
check('send_order accepté', orderAck.ok);
check('ordre relayé au chef', (await orderEvent).id === 'o-1');

// départ explicite
const leftEvent = once(leader, 'member_left');
member2.emit('leave_room');
const left = await leftEvent;
check('member_left (reason: left)', left.reason === 'left');

leader.disconnect();
member2.disconnect();

console.log(failures === 0 ? '\nE2E : tout passe.' : `\nE2E : ${failures} échec(s).`);
process.exit(failures === 0 ? 0 : 1);
