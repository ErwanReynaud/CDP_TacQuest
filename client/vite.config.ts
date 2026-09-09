import { defineConfig } from 'vitest/config';

export default defineConfig({
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
