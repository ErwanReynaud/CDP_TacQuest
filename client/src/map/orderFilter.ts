import type { GraphicStyle, OrderMessage } from '@tq/shared/protocol';

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

function removedIds(orders: Map<string, OrderMessage>): Set<string> {
  const removed = new Set<string>();
  for (const o of orders.values()) {
    if (o.payload.kind === 'remove') removed.add(o.payload.orderId);
  }
  return removed;
}

/**
 * Graphiques effectivement visibles : les ordres `graphic` non visés par un
 * ordre `remove`. Pur (sans Leaflet) pour rester testable hors navigateur.
 */
export function visibleGraphics(orders: Map<string, OrderMessage>): GraphicOrder[] {
  const removed = removedIds(orders);
  const out: GraphicOrder[] = [];
  for (const o of orders.values()) {
    if (o.payload.kind !== 'graphic' || removed.has(o.id)) continue;
    const latlngs = lineStringLatLngs(o.payload.geojson);
    if (latlngs.length < 2) continue;
    out.push({ id: o.id, authorId: o.authorId, latlngs, style: o.payload.style ?? {} });
  }
  return out;
}

/** Waypoints (plots) visibles : ordres `waypoint` moins les `remove`. */
export function visibleWaypoints(orders: Map<string, OrderMessage>): WaypointOrder[] {
  const removed = removedIds(orders);
  const out: WaypointOrder[] = [];
  for (const o of orders.values()) {
    if (o.payload.kind !== 'waypoint' || removed.has(o.id)) continue;
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
