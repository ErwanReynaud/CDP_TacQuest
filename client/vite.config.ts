import { defineConfig } from 'vitest/config';

// @meshtastic/core embarque tslog, dont le chemin Node importe statiquement
// os/path/util. Sans ces alias, `vite build` échoue sur
// « "hostname" is not exported by __vite-browser-external ».
const nodeBuiltinShim = new URL('./src/shims/node-builtins.ts', import.meta.url).pathname;

export default defineConfig({
  resolve: {
    alias: { os: nodeBuiltinShim, path: nodeBuiltinShim, util: nodeBuiltinShim },
  },
  // Compatibilité max : vieux Android / WebView. Ajouter @vitejs/plugin-legacy
  // seulement si le terrain révèle des navigateurs pré-2017.
  build: { target: 'es2017' },
  server: {
    // Autorise l'accès via Tailscale (tailscale serve → vite dev).
    allowedHosts: ['.ts.net'],
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'node',
  },
});
