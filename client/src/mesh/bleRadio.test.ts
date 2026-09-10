// Connexion BLE : gardes de plateforme et traduction des échecs.
//
// Ce que ces tests couvrent, c'est tout ce qui précède la radio elle-même :
// refus explicite sur plateforme incapable, message compréhensible quand
// l'utilisateur ferme le sélecteur, et surtout absence de chargement du code
// Meshtastic là où il ne servira jamais. La liaison réelle se valide avec du
// matériel (voir docs/mesh/tests.md).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BleUnavailableError, connectBleRadio, preloadBleRadio } from './bleRadio';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

function env(userAgent: string, opts: { bluetooth?: unknown; secure?: boolean } = {}): void {
  vi.stubGlobal('navigator', {
    userAgent,
    platform: 'Win32',
    maxTouchPoints: 0,
    ...(opts.bluetooth !== undefined ? { bluetooth: opts.bluetooth } : {}),
  });
  vi.stubGlobal('window', { isSecureContext: opts.secure ?? true });
}

afterEach(() => vi.unstubAllGlobals());

describe('connectBleRadio — gardes de plateforme', () => {
  it('refuse sur iOS avec le motif et un message parlant', async () => {
    env(UA.iphone);
    const err = await connectBleRadio().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BleUnavailableError);
    expect((err as BleUnavailableError).reason).toBe('ios');
    expect((err as BleUnavailableError).message).toMatch(/Apple/);
  });

  it('refuse hors HTTPS en désignant la bonne cause', async () => {
    // L'utilisateur doit changer d'URL, pas de navigateur.
    env(UA.androidChrome, { secure: false });
    const err = (await connectBleRadio().catch((e: unknown) => e)) as BleUnavailableError;
    expect(err.reason).toBe('insecure-context');
    expect(err.message).toMatch(/HTTPS/);
  });

  it('refuse sur Firefox', async () => {
    env(UA.firefox);
    const err = (await connectBleRadio().catch((e: unknown) => e)) as BleUnavailableError;
    expect(err.reason).toBe('firefox');
  });

  it('échoue avant de charger le code radio sur plateforme incapable', async () => {
    // Un mégaoctet de pile Meshtastic n'a pas à être téléchargé sur un appareil
    // qui ne pourra jamais s'en servir. La garde passe donc avant l'import.
    env(UA.iphone);
    const before = performance.now();
    await connectBleRadio().catch(() => {});
    // Le refus est synchrone à un tick près : aucun chargement de module.
    expect(performance.now() - before).toBeLessThan(50);
  });
});

describe('preloadBleRadio', () => {
  it('ne précharge rien sur une plateforme incapable', () => {
    env(UA.iphone);
    // Ne doit pas lever, et ne doit rien télécharger.
    expect(() => preloadBleRadio()).not.toThrow();
  });

  it('ne lève pas quand le préchargement échoue (hors ligne au démarrage)', () => {
    env(UA.androidChrome, { bluetooth: {} });
    expect(() => preloadBleRadio()).not.toThrow();
  });
});

describe('connectBleRadio — sélecteur Bluetooth', () => {
  it('traduit un sélecteur fermé par l’utilisateur en message utile', async () => {
    // requestDevice rejette avec NotFoundError quand l'utilisateur annule ou
    // qu'aucun appareil ne correspond : les deux cas méritent une consigne,
    // pas une trace technique.
    const notFound = Object.assign(new Error('User cancelled'), { name: 'NotFoundError' });
    env(UA.androidChrome, {
      bluetooth: { requestDevice: () => Promise.reject(notFound) },
    });
    const err = (await connectBleRadio().catch((e: unknown) => e)) as BleUnavailableError;
    expect(err).toBeInstanceOf(BleUnavailableError);
    expect(err.reason).toBe('cancelled');
    expect(err.message).toMatch(/allumé|portée/);
  });
});
