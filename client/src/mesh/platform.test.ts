// Détection de plateforme et de disponibilité BLE.
//
// L'ordre des tests dans bleSupport() est ce qui compte : un diagnostic faux
// envoie l'utilisateur résoudre le mauvais problème sur le terrain.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { bleSupport, detectPlatform, isIOS, isStandalone } from './platform';

interface FakeEnv {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  bluetooth?: unknown;
  standalone?: boolean;
  secure?: boolean;
  displayMode?: 'browser' | 'standalone' | 'fullscreen';
}

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipadOS:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  desktopChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  desktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

function env(e: FakeEnv): void {
  vi.stubGlobal('navigator', {
    userAgent: e.userAgent,
    platform: e.platform ?? 'Win32',
    maxTouchPoints: e.maxTouchPoints ?? 0,
    ...(e.bluetooth !== undefined ? { bluetooth: e.bluetooth } : {}),
    ...(e.standalone !== undefined ? { standalone: e.standalone } : {}),
  });
  vi.stubGlobal('window', {
    isSecureContext: e.secure ?? true,
    matchMedia: (q: string) => ({
      media: q,
      matches: q === '(display-mode: browser)' ? (e.displayMode ?? 'browser') === 'browser' : false,
    }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('détection de plateforme', () => {
  it('reconnaît un iPhone', () => {
    env({ userAgent: UA.iphone });
    expect(isIOS()).toBe(true);
    expect(detectPlatform()).toBe('ios');
  });

  it('démasque un iPad qui se déclare macOS', () => {
    // iPadOS 13+ envoie l'UA d'un Mac ; seul le tactile le trahit.
    env({ userAgent: UA.ipadOS, platform: 'MacIntel', maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
  });

  it('ne prend pas un vrai Mac pour un iPad', () => {
    env({ userAgent: UA.desktopSafari, platform: 'MacIntel', maxTouchPoints: 0 });
    expect(isIOS()).toBe(false);
    expect(detectPlatform()).toBe('desktop');
  });

  it('distingue Android et bureau', () => {
    env({ userAgent: UA.androidChrome });
    expect(detectPlatform()).toBe('android');
    env({ userAgent: UA.desktopChrome });
    expect(detectPlatform()).toBe('desktop');
  });
});

describe('détection du mode autonome', () => {
  it('reconnaît une PWA installée en standalone', () => {
    env({ userAgent: UA.androidChrome, displayMode: 'standalone' });
    expect(isStandalone()).toBe(true);
  });

  it('reconnaît aussi le mode fullscreen', () => {
    // Un manifest en `fullscreen` ou `minimal-ui` ne déclenche pas
    // `(display-mode: standalone)` : tester l'inverse couvre les trois modes.
    env({ userAgent: UA.androidChrome, displayMode: 'fullscreen' });
    expect(isStandalone()).toBe(true);
  });

  it('reconnaît un onglet ordinaire', () => {
    env({ userAgent: UA.androidChrome, displayMode: 'browser' });
    expect(isStandalone()).toBe(false);
  });

  it('accepte le drapeau non standard d’iOS', () => {
    env({ userAgent: UA.iphone, displayMode: 'browser', standalone: true });
    expect(isStandalone()).toBe(true);
  });
});

describe('disponibilité du Bluetooth Web', () => {
  it('refuse iOS avec un motif explicite, même en HTTPS', () => {
    env({ userAgent: UA.iphone, secure: true });
    const s = bleSupport();
    expect(s.supported).toBe(false);
    expect(s.reason).toBe('ios');
    expect(s.message).toMatch(/Apple/);
  });

  it('refuse iOS même si une API bluetooth était exposée', () => {
    // Cause racine définitive : elle prime sur tout le reste.
    env({ userAgent: UA.iphone, bluetooth: {}, secure: true });
    expect(bleSupport().reason).toBe('ios');
  });

  it('diagnostique une origine non sécurisée plutôt que « navigateur non supporté »', () => {
    // Hors HTTPS, navigator.bluetooth est absent sur un Chrome parfaitement
    // capable : c'est l'URL qu'il faut changer, pas le navigateur.
    env({ userAgent: UA.desktopChrome, secure: false });
    const s = bleSupport();
    expect(s.reason).toBe('insecure-context');
    expect(s.message).toMatch(/HTTPS/);
  });

  it('nomme Safari et Firefox quand l’API manque', () => {
    env({ userAgent: UA.desktopSafari, platform: 'MacIntel', secure: true });
    expect(bleSupport().reason).toBe('safari');
    env({ userAgent: UA.firefox, secure: true });
    expect(bleSupport().reason).toBe('firefox');
  });

  it('accepte Chrome sur Android et sur bureau en HTTPS', () => {
    for (const ua of [UA.androidChrome, UA.desktopChrome]) {
      env({ userAgent: ua, bluetooth: {}, secure: true });
      expect(bleSupport().supported).toBe(true);
    }
  });
});
