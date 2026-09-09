// Recherche de lieux via le géocodage de la Géoplateforme IGN (libre, sans clé,
// même écosystème que les fonds de carte). Les index interrogés couvrent les
// adresses ET les POI/lieux-dits (bois, cotes, fermes…) — précieux en terrain.
// NB : public/sw.js exclut /geocodage du cache de tuiles de data.geopf.fr.

export interface PlaceResult {
  /** Libellé principal (adresse complète ou toponyme). */
  name: string;
  /** Contexte affiché en second (catégorie, commune). */
  context: string;
  lat: number;
  lng: number;
}

const ENDPOINT = 'https://data.geopf.fr/geocodage/search';

/** Premier élément d'un champ qui peut être une chaîne ou un tableau. */
function first(v: unknown): string {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : '';
  return typeof v === 'string' ? v : '';
}

/** Extrait les résultats d'une réponse GeoJSON du géocodage (tolérant). */
export function parseGeocodeResponse(data: unknown): PlaceResult[] {
  const features = (data as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const out: PlaceResult[] = [];
  for (const f of features) {
    const geometry = (f as { geometry?: { coordinates?: unknown } }).geometry;
    const coords = geometry?.coordinates;
    if (!Array.isArray(coords) || typeof coords[0] !== 'number' || typeof coords[1] !== 'number')
      continue;
    const p = ((f as { properties?: unknown }).properties ?? {}) as Record<string, unknown>;
    // Adresse : label + city ; POI : toponym + category[] + city[].
    const name = first(p.label) || first(p.toponym) || first(p.name);
    if (!name) continue;
    const city = first(p.city) || first(p.postcode);
    const category = first(p.category);
    const context = [category, city].filter(Boolean).join(' · ');
    out.push({ name, context, lat: coords[1], lng: coords[0] });
  }
  return out;
}

/** Interroge le géocodage (adresses + POI). Lève en cas d'échec réseau. */
export async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&index=address,poi&limit=6`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`geocodage HTTP ${res.status}`);
  return parseGeocodeResponse(await res.json());
}
