import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { MAX_ORDER_BYTES } from '@tq/shared/constants';
import { registerHandlers } from './handlers';
import { RoomManager } from './rooms';
import { IpRateLimiter } from './rateLimit';
import { createPersistence } from './persistence';
import { createAdminRouter } from './admin';

const PORT = Number(process.env.PORT ?? 3000);
// DATA_DIR = volume persistant en prod (cf. fly.toml), dossier local en dev.
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), '.data');
const SNAPSHOT_PATH = process.env.SNAPSHOT_PATH ?? path.join(DATA_DIR, 'snapshot.json');
const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS ?? 10_000);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(dirname, '../../client/dist');

const manager = new RoomManager();
const persistence = createPersistence(manager, SNAPSHOT_PATH, SNAPSHOT_INTERVAL_MS);

const app = express();
app.disable('x-powered-by');

// En-têtes de sécurité (défense en profondeur). La CSP est le filet sous
// l'échappement/assainissement côté client (le contenu relayé est non fiable) :
// script-src 'self' interdit tout JS injecté. 'unsafe-inline' est nécessaire
// UNIQUEMENT pour le CSS — Leaflet injecte une <style> et l'app pose des styles
// en ligne (couleurs des figurés déjà passées par safeColor). Les hôtes listés
// sont les fonds de carte (img) + géocodage IGN et altitude (connect).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://data.geopf.fr https://server.arcgisonline.com https://*.tile.opentopomap.org",
  "connect-src 'self' https://data.geopf.fr https://api.open-meteo.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Doit dépasser MAX_ORDER_BYTES ; tout le reste est minuscule.
  maxHttpBufferSize: MAX_ORDER_BYTES * 2,
});

// Console d'administration (montée AVANT le fallback SPA qui happe tout le reste).
app.use('/admin', createAdminRouter(io, manager));

if (existsSync(clientDist)) {
  app.use(
    express.static(clientDist, {
      setHeaders(res, filePath) {
        // index.html et sw.js pilotent les mises à jour : jamais cachés.
        if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // Fallback SPA.
  app.use((_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.use((_req, res) => {
    res.status(503).send('Client non construit : lancez `npm run build` (ou utilisez le serveur de dev Vite).');
  });
}

const stopHandlers = registerHandlers(io, manager, new IpRateLimiter());

async function main() {
  // Recharger l'état AVANT d'écouter : les clients qui se reconnectent doivent
  // retrouver leur room dès le premier rejoin.
  await persistence.load();
  persistence.start();
  httpServer.listen(PORT, () => {
    console.log(`TacticalQuest serveur sur http://localhost:${PORT}`);
  });
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} reçu : sauvegarde de l'état puis arrêt.`);
  persistence.stop();
  stopHandlers();
  io.close();
  // Snapshot final : on ne perd pas les secondes depuis la dernière sauvegarde.
  await persistence.save();
  process.exit(0);
}
// Fly envoie SIGTERM avant chaque arrêt/redéploiement.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void main();
