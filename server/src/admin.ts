import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@tq/shared/protocol';
import type { RoomManager } from './rooms';
import { AdminAuthLimiter } from './rateLimit';
import { resolveClientIp } from './clientIp';
import { ADMIN_HTML } from './adminPage';

type TqServer = Server<ClientToServerEvents, ServerToClientEvents>;

// Délai fixe sur un code refusé : ralentit le brute-force du code admin.
const FAILED_AUTH_DELAY_MS = 600;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Vrai si la requête arrive en HTTPS (ou en local). Le secret admin circule en
 * clair dans l'en-tête : on refuse tout transport non chiffré. Sur Fly/Caddy le
 * proxy pose `x-forwarded-proto: https`. En dev (localhost) on tolère http, et
 * `ADMIN_ALLOW_INSECURE=1` force la tolérance si besoin.
 */
function isSecureRequest(req: Request): boolean {
  if (process.env.ADMIN_ALLOW_INSECURE === '1') return true;
  if (req.secure) return true; // TLS direct (req.protocol === 'https')
  const proto = (req.get('x-forwarded-proto') ?? '').split(',')[0]!.trim().toLowerCase();
  if (proto === 'https') return true;
  const host = (req.get('host') ?? '').split(':')[0]!.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** IP réelle du client (cf. resolveClientIp) — pour le verrou anti brute-force. */
function clientIp(req: Request): string {
  return resolveClientIp((n) => req.get(n), req.socket.remoteAddress ?? 'unknown');
}

/** Comparaison à temps constant de deux hex de même longueur (sha256). */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Console d'administration. Protégée par un code dont seul le **hash sha256**
 * vit côté serveur, dans le secret `ADMIN_CODE_HASH` (cf. scripts/admin-hash.mjs
 * pour le calculer, puis `fly secrets set ADMIN_CODE_HASH=…`). Sans ce secret,
 * toute la zone /admin renvoie 503 (désactivée).
 */
export function createAdminRouter(io: TqServer, manager: RoomManager): Router {
  const router = Router();
  const limiter = new AdminAuthLimiter();

  // HTTPS obligatoire sur toute la zone : le code circule en clair dans l'en-tête,
  // et on ne veut pas non plus servir le formulaire de login sur du http.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (isSecureRequest(req)) { next(); return; }
    res.status(403).type('text').send('HTTPS requis pour la console d’administration.');
  });

  // La page elle-même est publique (elle ne fait qu'inviter à saisir le code) ;
  // ce sont les appels /admin/api/* qui sont authentifiés.
  router.get('/', (_req, res) => {
    // CSP dédiée : la page admin est auto-suffisante mais porte son JS et son
    // CSS en ligne (script/style inline), incompatibles avec la CSP stricte du
    // client. Tout reste same-origin ; 'unsafe-inline' est cantonné ici.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
        "connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
    res.type('html').send(ADMIN_HTML);
  });

  const api = Router();
  api.use(jsonBody);

  // --- authentification -----------------------------------------------------
  api.use((req: Request, res: Response, next: NextFunction) => {
    const expected = process.env.ADMIN_CODE_HASH;
    if (!expected) { res.status(503).json({ error: 'admin_disabled' }); return; }
    const ip = clientIp(req);
    // Verrou anti brute-force : trop d'échecs récents pour cette IP → 429.
    if (!limiter.allow(ip)) {
      res.set('Retry-After', String(limiter.retryAfterSec(ip)));
      res.status(429).json({ error: 'too_many_attempts' });
      return;
    }
    const header = req.get('authorization') ?? '';
    const code = header.startsWith('Bearer ') ? header.slice(7) : (req.get('x-admin-code') ?? '');
    if (code && hashesEqual(sha256Hex(code), expected.trim().toLowerCase())) {
      limiter.reset(ip);
      next();
      return;
    }
    limiter.recordFailure(ip);
    setTimeout(() => res.status(401).json({ error: 'unauthorized' }), FAILED_AUTH_DELAY_MS);
  });

  // --- routes ---------------------------------------------------------------
  api.get('/rooms', (_req, res) => {
    res.json({ now: Date.now(), rooms: manager.summarize() });
  });

  api.post('/rooms/:code/close', (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!manager.closeRoom(code)) { res.status(404).json({ error: 'room_not_found' }); return; }
    io.to(code).emit('room_closed', { reason: 'closed' });
    void io.in(code).socketsLeave(code);
    res.status(204).end();
  });

  api.post('/rooms/:code/extend', (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!manager.extendRoom(code)) { res.status(404).json({ error: 'room_not_found' }); return; }
    res.json({ ok: true });
  });

  api.post('/rooms/:code/kick', (req, res) => {
    const code = req.params.code.toUpperCase();
    const memberId = (req.body as { memberId?: unknown })?.memberId;
    if (typeof memberId !== 'string') { res.status(400).json({ error: 'bad_request' }); return; }
    const removed = manager.kickMember(code, memberId);
    if (!removed) { res.status(404).json({ error: 'member_not_found' }); return; }
    // Prévient le membre exclu (sa PWA efface la session), puis coupe son socket.
    if (removed.socketId) {
      const sock = io.sockets.sockets.get(removed.socketId);
      sock?.emit('room_closed', { reason: 'kicked' });
      sock?.disconnect(true);
    }
    io.to(code).emit('member_left', { memberId, reason: 'kicked' });
    res.status(204).end();
  });

  router.use('/api', api);
  return router;
}

/** Parse JSON minimal sans dépendre du body-parser global (limite serrée). */
function jsonBody(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') { next(); return; }
  let raw = '';
  let tooBig = false;
  req.on('data', (chunk: Buffer) => {
    raw += chunk;
    if (raw.length > 4096) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return;
    try { req.body = raw ? JSON.parse(raw) : {}; next(); }
    catch { res.status(400).json({ error: 'bad_json' }); }
  });
}
