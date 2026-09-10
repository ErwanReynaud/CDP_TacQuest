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
  const { createBleRadio } = await import('./bleRadioImpl');
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
