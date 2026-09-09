// Quantification des coordonnées : ancre de zone d'opération + delta int16.
//
// Une ancre (8 o) est diffusée une fois par l'opcode ANCHOR ; chaque point ne
// coûte ensuite que 4 o (dE, dN en mètres), pour une enveloppe de ±32,7 km et
// une résolution de 1 m. Un rectangle tient donc en 8 o de géométrie.

import { ANCHOR_RANGE_M } from './constants';

/** Ancre de zone d'opération, stockée en 1e-7 degré (même échelle que Meshtastic). */
export interface Anchor {
  /** Latitude de l'ancre, en degrés décimaux. */
  lat: number;
  /** Longitude de l'ancre, en degrés décimaux. */
  lng: number;
}

/** Offsets entiers en mètres depuis l'ancre (est / nord). */
export interface Offset {
  dE: number;
  dN: number;
}

/**
 * Mètres par degré de latitude, série WGS84 tronquée.
 * Exacte à mieux que 1 cm sur toute la plage utile.
 */
export function metresPerDegLat(latDeg: number): number {
  const p = (latDeg * Math.PI) / 180;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
}

/** Mètres par degré de longitude à la latitude donnée. */
export function metresPerDegLng(latDeg: number): number {
  const p = (latDeg * Math.PI) / 180;
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
}

/**
 * Latitude maximale supportée. Au-delà, l'échelle en longitude s'effondre
 * (cos φ → 0) et les offsets int16 débordent. C'est aussi la limite de l'UTM,
 * donc du MGRS affiché par l'UI : rien à perdre.
 */
export const MAX_ABS_LAT = 84;

/**
 * Projette un point sur l'ancre. Renvoie `null` hors enveloppe : l'appelant
 * doit alors renégocier une ancre (opcode ANCHOR) plutôt que tronquer.
 *
 * L'échelle en longitude est prise à la latitude *quantifiée* du point, pas à
 * celle de l'ancre : sans cela, un point à 32 km à l'est et 0,3° au nord d'une
 * ancre à 45° dérive de ~170 m. `decode` refait exactement le même calcul, donc
 * l'aller-retour est stable au pas de quantification près.
 */
export function encodeOffset(anchor: Anchor, lat: number, lng: number): Offset | null {
  if (Math.abs(anchor.lat) > MAX_ABS_LAT || Math.abs(lat) > MAX_ABS_LAT) return null;
  const kLat = metresPerDegLat(anchor.lat);
  const dN = Math.round((lat - anchor.lat) * kLat);
  if (!Number.isFinite(dN) || Math.abs(dN) > ANCHOR_RANGE_M) return null;
  const latQ = anchor.lat + dN / kLat;
  const kLng = metresPerDegLng(latQ);
  const dE = Math.round((lng - anchor.lng) * kLng);
  if (!Number.isFinite(dE) || Math.abs(dE) > ANCHOR_RANGE_M) return null;
  return { dE, dN };
}

/** Inverse exact de `encodeOffset` (mêmes échelles, dans le même ordre). */
export function decodeOffset(anchor: Anchor, off: Offset): { lat: number; lng: number } {
  const kLat = metresPerDegLat(anchor.lat);
  const lat = anchor.lat + off.dN / kLat;
  const kLng = metresPerDegLng(lat);
  const lng = anchor.lng + off.dE / kLng;
  return { lat, lng };
}

/** Sérialisation de l'ancre elle-même : 2 × int32 en 1e-7 degré (8 o). */
export function anchorToE7(a: Anchor): { latE7: number; lngE7: number } {
  return { latE7: Math.round(a.lat * 1e7), lngE7: Math.round(a.lng * 1e7) };
}

export function anchorFromE7(latE7: number, lngE7: number): Anchor {
  return { lat: latE7 / 1e7, lng: lngE7 / 1e7 };
}

/**
 * Ancre canonique d'une zone : arrondi au 0,01° le plus proche (~1 km).
 *
 * Réduit la fréquence des désaccords entre nœuds partant du même secteur, mais
 * ne les supprime pas : deux points distants de quelques centaines de mètres de
 * part et d'autre d'une frontière de case tombent sur des ancres différentes.
 * La convergence est assurée par la trame ANCHOR, pas par cet arrondi
 * (cf. docs/mesh/protocol.md § 3).
 */
export function canonicalAnchor(lat: number, lng: number): Anchor {
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };
}

/** Le point tient-il dans l'enveloppe de l'ancre ? */
export function withinAnchor(anchor: Anchor, lat: number, lng: number): boolean {
  return encodeOffset(anchor, lat, lng) !== null;
}
