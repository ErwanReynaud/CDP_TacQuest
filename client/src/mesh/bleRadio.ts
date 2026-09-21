// Point d'entrée de la connexion au module Meshtastic.
//
// Ce fichier reste volontairement léger : il ne dépend ni de @meshtastic/core
// ni du runtime protobuf, qui pèsent ensemble près d'un mégaoctet. Ils ne sont
// chargés qu'au moment où l'utilisateur appaire réellement un module, par
// import dynamique — la carte, le GPS et le mode serveur n'ont pas à payer le
// poids d'une fonctionnalité radio qu'ils n'utilisent pas.

import type { Types } from '@meshtastic/core';
import { bleSupport } from './platform';
import type { Radio } from './radio';

/** Bluetooth indisponible ou refusé : porte le motif pour l'affichage. */
export class BleUnavailableError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = 'BleUnavailableError';
    this.reason = reason;
  }
}

export interface BleRadioOptions {
  /** Canal Meshtastic portant la salle (0 = primaire). */
  channel?: Types.ChannelNumber;
}

interface BluetoothApi {
  requestDevice?: unknown;
  getAvailability?: () => Promise<boolean>;
}

function bluetooth(): BluetoothApi | undefined {
  return (navigator as unknown as { bluetooth?: BluetoothApi }).bluetooth;
}

/**
 * Traduit un échec du Bluetooth Web en consigne exploitable sur le terrain.
 *
 * Les rejets de `requestDevice` et du GATT sont des `DOMException` dont seul le
 * `name` est stable ; le texte varie d'une version de Chrome à l'autre. On se
 * fonde donc sur le `name`, en n'utilisant le message que là où un même `name`
 * recouvre deux situations opposées — `NotFoundError` désigne aussi bien un
 * sélecteur fermé à la main qu'un adaptateur Bluetooth absent ou éteint, et la
 * consigne n'est pas la même.
 *
 * Le détail technique est conservé en queue de message : c'est ce que
 * l'utilisateur recopiera depuis le journal de diagnostic si la consigne ne
 * suffit pas.
 */
export function describeBleFailure(err: unknown): BleUnavailableError {
  if (err instanceof BleUnavailableError) return err;
  const name = (err as { name?: string }).name ?? '';
  const raw = (err as { message?: string }).message ?? String(err);
  const detail = `[${name || 'Error'}: ${raw}]`;
  const fail = (message: string, reason: string): BleUnavailableError =>
    new BleUnavailableError(`${message} ${detail}`, reason);

  if (name === 'NotFoundError') {
    // Chrome emploie le même nom pour « pas d'adaptateur » et « sélecteur
    // fermé ». Le premier cas rejette sans jamais ouvrir le sélecteur, ce qui
    // à l'écran ressemble à un bouton qui ne fait rien : il faut le nommer.
    if (/adapter|not available|not turned on|off/i.test(raw)) {
      return fail(
        'Le Bluetooth est éteint ou inaccessible au navigateur. Activez le Bluetooth ' +
          'de l’appareil, puis autorisez « Appareils à proximité » pour Chrome dans les ' +
          'réglages Android (Applications → Chrome → Autorisations).',
        'adapter-off',
      );
    }
    return fail(
      'Aucun module sélectionné. Vérifiez que le module est allumé, à portée, ' +
        'que son Bluetooth est activé, et qu’il n’est pas déjà connecté à un autre ' +
        'appareil — fermez notamment l’application Meshtastic officielle, qui garde ' +
        'la liaison pour elle.',
      'cancelled',
    );
  }
  if (name === 'SecurityError') {
    return fail(
      'Le navigateur a refusé d’ouvrir le sélecteur Bluetooth : la demande doit suivre ' +
        'immédiatement un appui. Réessayez ; si cela se reproduit, rechargez la page ' +
        'avant d’appuyer sur « Connecter ».',
      'no-gesture',
    );
  }
  if (name === 'NotAllowedError') {
    return fail(
      'Autorisation Bluetooth refusée. Accordez « Appareils à proximité » à Chrome dans ' +
        'les réglages Android, puis réessayez.',
      'denied',
    );
  }
  if (name === 'NetworkError') {
    return fail(
      'La liaison avec le module a échoué ou s’est interrompue. Rapprochez-vous du ' +
        'module, vérifiez qu’il est allumé, et qu’aucun autre appareil ne lui est déjà ' +
        'connecté.',
      'link-lost',
    );
  }
  if (name === 'NotSupportedError' || name === 'InvalidStateError') {
    return fail(
      'Le module a refusé la connexion. Éteignez-le et rallumez-le, puis oubliez-le ' +
        'dans les réglages Bluetooth d’Android avant de réessayer.',
      'gatt-refused',
    );
  }
  return fail('Connexion Bluetooth impossible.', 'connect-failed');
}

/**
 * Ouvre le sélecteur Bluetooth du navigateur, se connecte au module choisi et
 * attend la fin de sa configuration.
 *
 * Lève `BleUnavailableError` **avant** de charger quoi que ce soit si la
 * plateforme ne peut pas convenir : sur iOS `navigator.bluetooth` est
 * simplement absent, et sans cette garde l'appel échouerait sur un `TypeError`
 * incompréhensible. Cela évite au passage de télécharger un mégaoctet de code
 * radio sur un appareil qui ne pourra jamais s'en servir.
 */
export async function connectBleRadio(opts: BleRadioOptions = {}): Promise<Radio> {
  const support = bleSupport();
  if (!support.supported) {
    throw new BleUnavailableError(support.message, support.reason ?? 'unsupported');
  }

  // `navigator.bluetooth` existe même quand la radio de l'appareil est éteinte.
  // Sans ce contrôle, `requestDevice` rejette en une fraction de seconde sans
  // ouvrir de sélecteur : le bouton semble ne rien faire. On nomme la cause
  // avant d'en arriver là. L'API est absente de quelques implémentations, et
  // peut rejeter derrière une permissions-policy : dans le doute on laisse
  // passer, `requestDevice` tranchera.
  const api = bluetooth();
  if (typeof api?.getAvailability === 'function') {
    const available = await api.getAvailability().catch(() => true);
    if (!available) {
      throw new BleUnavailableError(
        'Le Bluetooth est désactivé sur cet appareil. Activez-le dans les réglages ' +
          'Android (ou la barre de réglages rapides), puis réessayez.',
        'adapter-off',
      );
    }
  }

  let createBleRadio: (o: BleRadioOptions) => Promise<Radio>;
  try {
    ({ createBleRadio } = await import('./bleRadioImpl'));
  } catch (err) {
    // Hors ligne avec un cache incomplet : le morceau de code radio n'a jamais
    // été téléchargé. Sans ce message, l'échec ressemble à une panne radio
    // alors qu'il suffit de repasser une fois en ligne.
    throw new BleUnavailableError(
      'Le code radio n’a pas pu être chargé. Reconnectez-vous une fois à Internet ' +
        `pour le télécharger, puis réessayez hors ligne. [${String(err)}]`,
      'chunk-failed',
    );
  }
  return createBleRadio(opts);
}

/**
 * Précharge le code radio en tâche de fond.
 *
 * Le service worker met en cache les assets à la première requête. Sans ce
 * préchargement, un utilisateur qui installe l'app à la base puis part sur le
 * terrain découvrirait, en appairant son module hors ligne, que le morceau de
 * code correspondant n'a jamais été téléchargé — l'import dynamique échouerait
 * précisément là où il n'y a plus de réseau pour le réparer.
 *
 * Il protège aussi l'appui lui-même : `requestDevice` exige une activation
 * utilisateur récente, et sur un lien lent le téléchargement du module
 * l'épuiserait avant l'ouverture du sélecteur.
 *
 * Sans effet sur les plateformes incapables de Bluetooth : inutile d'y
 * dépenser de la bande passante pour du code qui ne servira jamais.
 */
export function preloadBleRadio(): void {
  if (!bleSupport().supported) return;
  void import('./bleRadioImpl').catch(() => {
    // Hors ligne au démarrage : on retentera au prochain lancement, et de
    // toute façon à la connexion elle-même.
  });
}
