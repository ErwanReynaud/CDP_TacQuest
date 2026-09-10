import type { GraphicStyle, OrderMessage } from '@tq/shared/protocol';
import { isHidden, suppression } from '../crdt/orders';

export interface GraphicOrder {
  id: string;
  authorId: string;
  /** Coordonnées [lat, lng] de la ligne. */
  latlngs: [number, number][];
  style: GraphicStyle;
}

export interface WaypointOrder {
  id: string;
  authorId: string;
  name: string;
  lat: number;
  lng: number;
  sidc?: string;
  /** Présent pour un point nommé (rond de couleur) ; absent pour un plot ENI. */
  color?: string;
}

/**
 * Graphiques effectivement visibles : les ordres `graphic` que ni un `remove`
 * ni un `clear` ne masquent. Pur (sans Leaflet) pour rester testable hors
 * navigateur.
 *
 * La règle de masquage vit dans crdt/orders.ts : elle est add-wins (une mise à
 * jour postérieure à une suppression fait réapparaître le figuré) et doit être
 * identique sur tous les nœuds, sans quoi deux cartes divergent.
 */
export function visibleGraphics(orders: Map<string, OrderMessage>): GraphicOrder[] {
  const hidden = suppression(orders);
  const out: GraphicOrder[] = [];
  for (const o of orders.values()) {
    if (o.payload.kind !== 'graphic' || isHidden(o, hidden)) continue;
    const latlngs = lineStringLatLngs(o.payload.geojson);
    if (latlngs.length < 2) continue;
    out.push({ id: o.id, authorId: o.authorId, latlngs, style: o.payload.style ?? {} });
  }
  return out;
}

/** Plots visibles : ordres `waypoint` que ni un `remove` ni un `clear` ne masquent. */
export function visibleWaypoints(orders: Map<string, OrderMessage>): WaypointOrder[] {
  const hidden = suppression(orders);
  const out: WaypointOrder[] = [];
  for (const o of orders.values()) {
    if (o.payload.kind !== 'waypoint' || isHidden(o, hidden)) continue;
    const { name, lat, lng, sidc, color } = o.payload;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    out.push({ id: o.id, authorId: o.authorId, name, lat, lng, sidc, color });
  }
  return out;
}

/** Extrait les sommets d'une Feature GeoJSON LineString, en validant. */
function lineStringLatLngs(geojson: unknown): [number, number][] {
  if (typeof geojson !== 'object' || geojson === null) return [];
  const geometry = (geojson as { geometry?: unknown }).geometry;
  if (typeof geometry !== 'object' || geometry === null) return [];
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type !== 'LineString' || !Array.isArray(g.coordinates)) return [];
  const out: [number, number][] = [];
  for (const c of g.coordinates) {
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') return [];
    out.push([c[1], c[0]]); // GeoJSON est [lng, lat]
  }
  return out;
}
