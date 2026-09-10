// Page d'installation : cohérence du garde-fou iOS avec la couche radio.

import { afterEach, describe, expect, it, vi } from 'vitest';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
};

interface Env {
  userAgent: string;
  bluetooth?: unknown;
  secure?: boolean;
  displayMode?: 'browser' | 'standalone';
  dismissed?: boolean;
}

function env(e: Env): void {
  vi.stubGlobal('navigator', {
    userAgent: e.userAgent,
    platform: 'Win32',
    maxTouchPoints: 0,
    ...(e.bluetooth !== undefined ? { bluetooth: e.bluetooth } : {}),
  });
  const store = new Map<string, string>();
  if (e.dismissed) store.set('tq-install-dismissed', '1');
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal('window', {
    isSecureContext: e.secure ?? true,
    matchMedia: (q: string) => ({
      media: q,
      matches: q === '(display-mode: browser)' ? (e.displayMode ?? 'browser') === 'browser' : false,
    }),
  });
}

async function gate() {
  return await import('./installGate');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('shouldShowInstallGate', () => {
  it('s’affiche sur mobile dans un navigateur', async () => {
    env({ userAgent: UA.androidChrome, bluetooth: {} });
    expect((await gate()).shouldShowInstallGate()).toBe(true);
  });

  it('ne s’affiche pas une fois la PWA installée', async () => {
    env({ userAgent: UA.androidChrome, displayMode: 'standalone' });
    expect((await gate()).shouldShowInstallGate()).toBe(false);
  });

  it('ne s’affiche pas sur poste fixe', async () => {
    // L'app est pleinement utilisable dans un onglet ; un navigateur de bureau
    // incapable de Bluetooth est signalé ailleurs, pas par un écran bloquant.
    env({ userAgent: UA.desktopChrome, bluetooth: {} });
    expect((await gate()).shouldShowInstallGate()).toBe(false);
  });

  it('respecte le choix « continuer dans le navigateur »', async () => {
    env({ userAgent: UA.androidChrome, bluetooth: {}, dismissed: true });
    expect((await gate()).shouldShowInstallGate()).toBe(false);
  });
});

describe('avertissement sur le mode radio', () => {
  /** Rend la page dans un DOM minimal et renvoie son HTML. */
  async function render(e: Env): Promise<string> {
    env(e);
    const card: { html: string } = { html: '' };
    const el = {
      id: '',
      set innerHTML(v: string) { card.html = v; },
      querySelector: () => ({ addEventListener: () => {} }),
    };
    vi.stubGlobal('document', {
      createElement: () => el,
      body: { appendChild: () => {}, classList: { add: () => {}, remove: () => {} } },
    });
    (await gate()).showInstallGate(() => {});
    return card.html;
  }

  it('prévient sur iOS que le module radio ne sera pas accessible', async () => {
    const html = await render({ userAgent: UA.iphone });
    expect(html).toContain('install-warning');
    expect(html).toMatch(/Apple/);
    // Et l'app reste installable : posture dégradée, pas blocage.
    expect(html).toContain('install-steps');
    expect(html).toContain('install-continue');
  });

  it('n’affiche aucun avertissement sur Android avec Bluetooth', async () => {
    const html = await render({ userAgent: UA.androidChrome, bluetooth: {} });
    expect(html).not.toContain('install-warning');
  });

  it('prévient aussi quand l’origine n’est pas sécurisée', async () => {
    // Serveur de campagne en HTTP sur le réseau local : l'API est masquée.
    const html = await render({ userAgent: UA.androidChrome, secure: false });
    expect(html).toContain('install-warning');
    expect(html).toMatch(/HTTPS/);
  });
});
