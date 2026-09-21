import { defineConfig, type PluginOption } from 'vitest/config';

// @meshtastic/core embarque tslog, dont le chemin Node importe statiquement
// os/path/util. Sans ces alias, `vite build` échoue sur
// « "hostname" is not exported by __vite-browser-external ».
const nodeBuiltinShim = new URL('./src/shims/node-builtins.ts', import.meta.url).pathname;

/**
 * Certificat auto-signé pour le serveur de développement.
 *
 * Le Bluetooth Web n'existe qu'en contexte sécurisé : un téléphone qui ouvre
 * `http://192.168.x.x:5173` ne verra jamais `navigator.bluetooth`, et le bouton
 * « Connecter » restera inerte avec le message « connexion sécurisée exigée ».
 * Servir le dev en HTTPS, même sous un certificat que le navigateur signale,
 * est ce qui rend la radio essayable sur le réseau local.
 *
 * Chargé paresseusement et seulement pour `vite dev` : l'image de production
 * bâtit sans ce paquet, et un `npm ci --omit=dev` continue de fonctionner.
 */
async function devHttps(): Promise<PluginOption[]> {
  const { default: basicSsl } = await import('@vitejs/plugin-basic-ssl');
  return [basicSsl()];
}

export default defineConfig(async ({ command }) => ({
  plugins: command === 'serve' ? await devHttps() : [],
  resolve: {
    alias: { os: nodeBuiltinShim, path: nodeBuiltinShim, util: nodeBuiltinShim },
  },
  // Compatibilité max : vieux Android / WebView. Ajouter @vitejs/plugin-legacy
  // seulement si le terrain révèle des navigateurs pré-2017.
  build: { target: 'es2017' },
  server: {
    // Écoute sur toutes les interfaces : c'est ce qui rend le serveur
    // joignable depuis le téléphone, sur le même réseau que l'ordinateur.
    host: true,
    port: 5173,
    // Autorise l'accès via Tailscale (tailscale serve → vite dev).
    allowedHosts: ['.ts.net'],
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'node',
  },
}));
