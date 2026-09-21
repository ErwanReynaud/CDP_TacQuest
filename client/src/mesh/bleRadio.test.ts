// Connexion BLE : gardes de plateforme et traduction des échecs.
//
// Ce que ces tests couvrent, c'est tout ce qui précède la radio elle-même :
// refus explicite sur plateforme incapable, message compréhensible quand
// l'utilisateur ferme le sélecteur, et surtout absence de chargement du code
// Meshtastic là où il ne servira jamais. La liaison réelle se valide avec du
// matériel (voir docs/mesh/tests.md).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BleUnavailableError,
  connectBleRadio,
  describeBleFailure,
  preloadBleRadio,
} from './bleRadio';

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

/** Exception du Bluetooth Web, telle que Chrome la rejette. */
function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
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
    const notFound = domError('NotFoundError', 'User cancelled the requestDevice() chooser.');
    env(UA.androidChrome, {
      bluetooth: { requestDevice: () => Promise.reject(notFound) },
    });
    const err = (await connectBleRadio().catch((e: unknown) => e)) as BleUnavailableError;
    expect(err).toBeInstanceOf(BleUnavailableError);
    expect(err.reason).toBe('cancelled');
    expect(err.message).toMatch(/allumé|portée/);
  });
});

describe('connectBleRadio — Bluetooth éteint', () => {
  it('refuse avant d’ouvrir le sélecteur quand l’adaptateur est indisponible', async () => {
    // Symptôme observé sur le terrain : le bouton affiche « Recherche du
    // module… » une demi-seconde puis plus rien, parce que requestDevice
    // rejette sans jamais ouvrir de sélecteur. getAvailability le dit avant.
    const requestDevice = vi.fn();
    env(UA.androidChrome, {
      bluetooth: { requestDevice, getAvailability: () => Promise.resolve(false) },
    });
    const err = (await connectBleRadio().catch((e: unknown) => e)) as BleUnavailableError;
    expect(err).toBeInstanceOf(BleUnavailableError);
    expect(err.reason).toBe('adapter-off');
    expect(err.message).toMatch(/activez-le/i);
    expect(requestDevice).not.toHaveBeenCalled();
  });

  it('n’interrompt pas la connexion si getAvailability échoue', async () => {
    // Derrière une permissions-policy, l'appel rejette alors que le Bluetooth
    // est parfaitement utilisable : on laisse requestDevice trancher.
    env(UA.androidChrome, {
      bluetooth: {
        requestDevice: () => Promise.reject(domError('NotFoundError', 'User cancelled')),
        getAvailability: () => Promise.reject(new Error('disallowed')),
      },
    });
    const err = (await connectBleRadio().catch((e: unknown) => e)) as BleUnavailableError;
    expect(err.reason).toBe('cancelled');
  });
});

describe('describeBleFailure', () => {
  it('distingue un adaptateur absent d’un sélecteur fermé', () => {
    // Chrome donne le même `name` aux deux : seul le texte les sépare, et les
    // consignes sont opposées (allumer le Bluetooth vs. allumer le module).
    const off = describeBleFailure(domError('NotFoundError', 'Bluetooth adapter not available.'));
    expect(off.reason).toBe('adapter-off');
    const cancelled = describeBleFailure(
      domError('NotFoundError', 'User cancelled the requestDevice() chooser.'),
    );
    expect(cancelled.reason).toBe('cancelled');
  });

  it('nomme l’app officielle, qui accapare la liaison', () => {
    // Cause n°1 d'un sélecteur vide : le module est déjà connecté ailleurs.
    const err = describeBleFailure(domError('NotFoundError', 'User cancelled'));
    expect(err.message).toMatch(/Meshtastic officielle/);
  });

  it('traduit une activation utilisateur expirée', () => {
    const err = describeBleFailure(
      domError('SecurityError', 'Must be handling a user gesture to show a permission request.'),
    );
    expect(err.reason).toBe('no-gesture');
  });

  it('traduit un refus d’autorisation et une liaison perdue', () => {
    expect(describeBleFailure(domError('NotAllowedError', 'denied')).reason).toBe('denied');
    expect(describeBleFailure(domError('NetworkError', 'GATT lost')).reason).toBe('link-lost');
  });

  it('conserve le détail technique pour le journal de diagnostic', () => {
    // La consigne sert à l'utilisateur ; le détail sert à qui dépanne.
    const err = describeBleFailure(domError('NetworkError', 'Connection failed abruptly'));
    expect(err.message).toContain('NetworkError');
    expect(err.message).toContain('Connection failed abruptly');
  });

  it('laisse passer une erreur déjà traduite sans la ré-emballer', () => {
    const original = new BleUnavailableError('déjà dit', 'ios');
    expect(describeBleFailure(original)).toBe(original);
  });

  it('reste compréhensible sur une exception inconnue', () => {
    const err = describeBleFailure(domError('WeirdError', 'boom'));
    expect(err.reason).toBe('connect-failed');
    expect(err.message).toMatch(/Connexion Bluetooth impossible/);
  });
});

describe('connectBleRadio — code radio absent du cache', () => {
  it('distingue un chargement de module raté d’une panne radio', async () => {
    // Hors ligne avec un cache incomplet, l'import dynamique échoue. Sans ce
    // message, l'utilisateur chercherait la panne du côté du module.
    vi.doMock('./bleRadioImpl', () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    env(UA.androidChrome, { bluetooth: { requestDevice: () => Promise.reject(new Error('x')) } });
    // Le module de tête a déjà été évalué : on le réévalue pour que son import
    // dynamique voie la simulation d'échec.
    vi.resetModules();
    const fresh = await import('./bleRadio');
    const err = (await fresh.connectBleRadio().catch((e: unknown) => e)) as BleUnavailableError;
    expect(err.reason).toBe('chunk-failed');
    expect(err.message).toMatch(/Internet/);
    vi.doUnmock('./bleRadioImpl');
    vi.resetModules();
  });
});
