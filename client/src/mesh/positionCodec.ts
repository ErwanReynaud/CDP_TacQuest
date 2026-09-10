// Conversion Position TacQuest ↔ Position Meshtastic (POSITION_APP).
//
// Seul endroit où les deux modèles se rencontrent, et seul point à revoir si
// Meshtastic fait évoluer son schéma.

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Protobuf } from '@meshtastic/core';
import type { Position } from '@tq/shared/protocol';

const Schema = Protobuf.Mesh.PositionSchema;

/**
 * Précision annoncée quand le nœud n'en fournit pas. Franchement pessimiste,
 * et volontairement : un 0 afficherait « ±0 m » sur un point dont on ne sait
 * rien, ce qui est pire qu'une valeur large et honnête.
 */
const UNKNOWN_ACCURACY_M = 100;

/**
 * Encode une position du téléphone pour POSITION_APP.
 *
 * `LOC_EXTERNAL` et non `LOC_INTERNAL` : le fix vient du GPS du téléphone, pas
 * du récepteur du module. La distinction est visible depuis un client
 * Meshtastic standard.
 */
export function encodePosition(p: Position): Uint8Array {
  return toBinary(
    Schema,
    create(Schema, {
      latitudeI: Math.round(p.lat * 1e7),
      longitudeI: Math.round(p.lng * 1e7),
      time: Math.round(p.ts / 1000),
      locationSource: Protobuf.Mesh.Position_LocSource.LOC_EXTERNAL,
      // `gps_accuracy` est exprimé en millimètres côté Meshtastic.
      gpsAccuracy: Math.max(0, Math.round(p.accuracy * 1000)),
      // `ground_track` est en degrés × 1e-5 ; `ground_speed` en m/s entiers.
      ...(p.heading != null ? { groundTrack: Math.round(p.heading * 1e5) } : {}),
      ...(p.speed != null ? { groundSpeed: Math.max(0, Math.round(p.speed)) } : {}),
    }),
  );
}

/**
 * Traduit une position Meshtastic déjà décodée.
 *
 * Tous les champs du schéma sont optionnels en proto3 : un nœud minimaliste
 * peut n'envoyer que la latitude. On ne divise donc jamais un champ absent
 * (`undefined / 1e7` donnerait `NaN`, et un marqueur en NaN/NaN disparaît de la
 * carte sans erreur).
 *
 * Renvoie `null` sur une position nulle : Meshtastic diffuse du 0/0 avant
 * acquisition du fix, et l'afficher placerait un équipier dans le golfe de
 * Guinée.
 */
export function fromMeshPosition(m: Protobuf.Mesh.Position, rxTime: Date): Position | null {
  const latI = m.latitudeI ?? 0;
  const lngI = m.longitudeI ?? 0;
  if (latI === 0 && lngI === 0) return null;
  const accuracyMm = m.gpsAccuracy ?? 0;
  const track = m.groundTrack ?? 0;
  const speed = m.groundSpeed ?? 0;
  const time = m.time ?? 0;
  return {
    lat: latI / 1e7,
    lng: lngI / 1e7,
    accuracy: accuracyMm > 0 ? accuracyMm / 1000 : UNKNOWN_ACCURACY_M,
    heading: track > 0 ? track / 1e5 : null,
    speed: speed > 0 ? speed : null,
    ts: time > 0 ? time * 1000 : rxTime.getTime(),
  };
}

/** Décode une position reçue sous forme binaire (POSITION_APP). */
export function decodePosition(bytes: Uint8Array, rxTime: Date): Position | null {
  return fromMeshPosition(fromBinary(Schema, bytes), rxTime);
}
