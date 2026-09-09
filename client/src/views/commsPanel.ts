// Comms : chat libre de la salle. Chacun peut envoyer des messages texte ;
// ils transitent comme des ordres `text` (transport optimiste + file hors-ligne).
import { state } from '../state';
import { sendOrder } from '../socket';
import { uid, escapeHtml } from '../util';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Longueur max d'un message (borne aussi côté serveur via MAX_ORDER_BYTES). */
const MAX_MESSAGE_LEN = 500;

interface Deps {
  notify: (text: string) => void;
}

interface ChatMessage {
  id: string;
  authorId: string;
  ts: number;
  body: string;
}

let deps: Deps;
// Messages déjà vus (pour ne notifier qu'une fois) et compteur de non-lus.
const seen = new Set<string>();
let unread = 0;
// Messages dont la liste des « lu par » est dépliée (état UI local).
const expandedLikers = new Set<string>();

export function initCommsPanel(d: Deps): void {
  deps = d;
  $('btn-comms').addEventListener('click', () => toggleComms());
  $('comms-close').addEventListener('click', () => closeComms());
  $('comms-send').addEventListener('click', sendChat);
  const input = $<HTMLInputElement>('comms-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
  });
  // Délégation : « lu / j'aime » (cm-like) et dépliage des lecteurs (cm-count).
  $('comms-messages').addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const like = el.closest<HTMLElement>('.cm-like');
    if (like?.dataset.id) return markRead(like.dataset.id);
    const count = el.closest<HTMLElement>('.cm-count');
    if (count?.dataset.id) {
      const id = count.dataset.id;
      if (expandedLikers.has(id)) expandedLikers.delete(id);
      else expandedLikers.add(id);
      renderComms();
    }
  });
}

function deriveMessages(): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const o of state.orders.values()) {
    if (o.payload.kind !== 'text') continue;
    out.push({ id: o.id, authorId: o.authorId, ts: o.ts, body: o.payload.body });
  }
  out.sort((a, b) => a.ts - b.ts); // ordre chronologique (chat)
  return out;
}

/**
 * Accusés de lecture (« likes ») : ordres `ack` référençant l'id d'un message.
 * Renvoie, par id de message, l'ensemble des membres l'ayant marqué lu. Relayés
 * et persistés comme tout ordre, donc reconstruits tels quels à la reconnexion.
 */
function deriveAcks(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const o of state.orders.values()) {
    if (o.payload.kind !== 'ack') continue;
    const set = map.get(o.payload.orderId) ?? new Set<string>();
    set.add(o.authorId);
    map.set(o.payload.orderId, set);
  }
  return map;
}

/** Marque un message comme lu (idempotent : un seul ack par membre et message). */
function markRead(orderId: string): void {
  const session = state.session;
  if (!session) return;
  if (deriveAcks().get(orderId)?.has(session.memberId)) return;
  sendOrder({
    id: uid(),
    authorId: session.memberId,
    ts: Date.now(),
    kind: 'ack',
    payload: { kind: 'ack', orderId },
  });
}

export function toggleComms(): void {
  if ($('comms-panel').hidden) openComms();
  else closeComms();
}

export function openComms(): void {
  $('comms-panel').hidden = false;
  unread = 0;
  renderComms();
  attachViewport();
  scrollToBottom();
  $<HTMLInputElement>('comms-input').focus();
}

export function closeComms(): void {
  $('comms-panel').hidden = true;
  detachViewport();
}

// --- clavier mobile : suivre le viewport visible ---
// Quand le clavier s'ouvre, la fenêtre visible (visualViewport) rétrécit alors
// que la fenêtre de mise en page ne bouge pas : un panneau ancré en bas reste
// derrière le clavier (dernier message + saisie masqués). On colle donc le
// panneau à la zone réellement visible, et on redescend au dernier message.
let vvApply: (() => void) | null = null;

function attachViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const panel = $('comms-panel');
  vvApply = () => {
    panel.style.top = `${vv.offsetTop}px`;
    panel.style.height = `${vv.height}px`;
    panel.style.bottom = 'auto';
    scrollToBottom();
  };
  vvApply();
  vv.addEventListener('resize', vvApply);
  vv.addEventListener('scroll', vvApply);
}

function detachViewport(): void {
  const panel = $('comms-panel');
  panel.style.top = '';
  panel.style.height = '';
  panel.style.bottom = '';
  const vv = window.visualViewport;
  if (vv && vvApply) {
    vv.removeEventListener('resize', vvApply);
    vv.removeEventListener('scroll', vvApply);
  }
  vvApply = null;
}

function isOpen(): boolean {
  return !$('comms-panel').hidden;
}

function sendChat(): void {
  const session = state.session;
  if (!session) return;
  const input = $<HTMLInputElement>('comms-input');
  const body = input.value.trim().slice(0, MAX_MESSAGE_LEN);
  if (!body) return;
  sendOrder({
    id: uid(),
    authorId: session.memberId,
    ts: Date.now(),
    kind: 'text',
    payload: { kind: 'text', body },
  });
  input.value = '';
  // sendOrder applique l'ordre et émet bus('orders') → renderComms ; on garde
  // juste le focus et on défile en bas.
  input.focus();
  scrollToBottom();
}

// --- rendu ---

export function renderComms(): void {
  if (!isOpen()) return;
  const list = $('comms-messages');
  const wasAtBottom = isScrolledToBottom();
  list.innerHTML = '';
  const messages = deriveMessages();
  if (messages.length === 0) {
    list.innerHTML = '<li class="comms-empty">Aucun message. Lancez les comms.</li>';
    return;
  }
  const me = state.session?.memberId;
  const acks = deriveAcks();
  for (const m of messages) {
    seen.add(m.id);
    list.appendChild(messageItem(m, m.authorId === me, acks.get(m.id) ?? new Set()));
  }
  if (wasAtBottom) scrollToBottom();
}

// Coche « lu / j'aime ».
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9 17.5 20 6.5"/></svg>';

function messageItem(m: ChatMessage, mine: boolean, likers: Set<string>): HTMLLIElement {
  const li = document.createElement('li');
  li.className = `comms-msg${mine ? ' mine' : ''}`;
  const me = state.session?.memberId;
  const likedByMe = !!me && likers.has(me);
  const count = likers.size;

  // Sur mes propres messages : pas de bouton (je ne me lis pas), mais je vois
  // qui a lu. Sur ceux des autres : bouton « lu » (accusé de lecture).
  const likeBtn = mine
    ? ''
    : `<button class="cm-like${likedByMe ? ' liked' : ''}" data-id="${m.id}" title="Marquer comme lu" aria-label="Marquer comme lu">${CHECK_SVG}</button>`;
  const countBtn = count ? `<button class="cm-count" data-id="${m.id}" title="Qui a lu">${CHECK_SVG} ${count}</button>` : '';
  const react = likeBtn || countBtn ? `<div class="cm-react">${likeBtn}${countBtn}</div>` : '';
  const likersList =
    expandedLikers.has(m.id) && count
      ? `<ul class="cm-likers">${[...likers].map((a) => `<li>${escapeHtml(callsign(a))}</li>`).join('')}</ul>`
      : '';

  li.innerHTML =
    `<span class="cm-head"><b>${escapeHtml(callsign(m.authorId))}</b>` +
    `<span class="cm-time">${time(m.ts)}</span></span>` +
    `<span class="cm-body">${escapeHtml(m.body)}</span>` +
    react +
    likersList;
  return li;
}

function isScrolledToBottom(): boolean {
  const list = $('comms-messages');
  return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
}

function scrollToBottom(): void {
  const list = $('comms-messages');
  list.scrollTop = list.scrollHeight;
}

// --- badge + notifications ---

/** Messages reçus non encore lus (panneau fermé). */
export function unreadCommsCount(): number {
  return unread;
}

/**
 * Notifie (toast + vibration) à chaque nouveau message d'un autre membre, et
 * incrémente le compteur de non-lus tant que le panneau est fermé.
 */
export function checkIncomingMessages(): void {
  const me = state.session?.memberId;
  if (!me) return;
  for (const m of deriveMessages()) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.authorId === me) continue; // nos propres messages : déjà vus
    if (isOpen()) continue; // lu en direct, pas de notif
    unread++;
    deps.notify(`${callsign(m.authorId)} : ${m.body}`);
    if ('vibrate' in navigator) navigator.vibrate?.([80, 50, 80]);
  }
}

export function resetCommsNotifications(): void {
  seen.clear();
  unread = 0;
  expandedLikers.clear();
}

// --- utilitaires ---

function callsign(memberId: string): string {
  const m = state.members.get(memberId);
  if (m) return m.callsign;
  if (memberId === state.session?.memberId) return state.session.callsign;
  return 'inconnu';
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
