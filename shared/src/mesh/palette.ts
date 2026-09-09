// Couleurs et dictionnaires : sur le fil, tout est un index.

import { MESH_PALETTE, MESH_SIDC_DICT } from './constants';

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/**
 * Index de palette le plus proche (distance euclidienne RVB). Une couleur hors
 * palette est donc rendue légèrement différemment chez le destinataire : perte
 * assumée, l'UI n'expose de toute façon qu'un jeu fermé de pastilles.
 * Une couleur illisible retombe sur l'index 0 (jaune par défaut des outils).
 */
export function colorToIndex(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < MESH_PALETTE.length; i++) {
    const p = parseHex(MESH_PALETTE[i]!)!;
    const d = (rgb[0] - p[0]) ** 2 + (rgb[1] - p[1]) ** 2 + (rgb[2] - p[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function indexToColor(i: number): string {
  return MESH_PALETTE[i & 0x0f] ?? MESH_PALETTE[0]!;
}

/** Index du SIDC, ou `null` s'il est hors dictionnaire (l'ordre part alors sans SIDC). */
export function sidcToIndex(sidc: string): number | null {
  const i = MESH_SIDC_DICT.indexOf(sidc);
  return i >= 0 ? i : null;
}

export function indexToSidc(i: number): string | undefined {
  return MESH_SIDC_DICT[i];
}
