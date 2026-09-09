/**
 * Élévation du terrain sous un point (lat/lng) via l'API Open-Meteo Elevation
 * (gratuite, sans clé, CORS) — MNT Copernicus 90 m, altitude en mètres / mer.
 *
 * Le bandeau de coordonnées suit le réticule central et bouge en continu : on
 * ne lance donc PAS une requête par déplacement. L'appelant débounce, et ici on
 * arrondit le point (~110 m) pour mutualiser le cache, on dédoublonne les
 * requêtes en vol, et on échoue silencieusement (hors-ligne / zone blanche) en
 * renvoyant null — l'altitude est alors simplement masquée.
 */

import { formatCoords } from './coords';

const cache = new Map<string, number>();
const inflight = new Map<string, Promise<number | null>>();
const FETCH_TIMEOUT_MS = 6_000;

/** Clé de cache : arrondie à 3 décimales (~110 m, sous la résolution du MNT). */
export function elevationKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/** Altitude déjà connue pour ce point, ou null (rien en cache). Synchrone. */
export function cachedElevation(lat: number, lng: number): number | null {
  return cache.get(elevationKey(lat, lng)) ?? null;
}

/** Récupère l'altitude (cache, requête en vol mutualisée, ou réseau). */
export function fetchElevation(lat: number, lng: number): Promise<number | null> {
  const k = elevationKey(lat, lng);
  const hit = cache.get(k);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(k);
  if (pending) return pending;
  // Inutile de pendre 6 s sur un timeout quand on se sait hors-ligne.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return Promise.resolve(null);
  }

  const [latR, lngR] = k.split(',');
  const p = (async (): Promise<number | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://api.open-meteo.com/v1/elevation?latitude=${latR}&longitude=${lngR}`,
        { signal: ctrl.signal },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { elevation?: number[] };
      const e = data.elevation?.[0];
      if (typeof e !== 'number' || !Number.isFinite(e)) return null;
      cache.set(k, e); // seuls les succès sont mémorisés : un échec se retentera
      return e;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/**
 * Fragment HTML « coordonnées + altitude » pour les popups. L'altitude est un
 * dernier groupe ajouté DANS le bloc coords (même police monospace), façon
 * groupe de coordonnée MGRS : « 31U FQ 14018 43518 158 ». Elle part vide
 * (`.coord-alt:empty` masqué) puis est remplie par hydrateAltitudes une fois le
 * fragment inséré dans le DOM.
 */
export function coordsWithAltitudeHtml(lat: number, lng: number): string {
  return (
    `<span class="coords">${formatCoords(lat, lng)}` +
    `<span class="coord-alt" data-elev="${lat},${lng}"></span></span>`
  );
}

/** Remplit les altitudes des fragments coordsWithAltitudeHtml déjà dans le DOM. */
export function hydrateAltitudes(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.coord-alt[data-elev]').forEach((el) => {
    const parts = (el.dataset.elev ?? '').split(',');
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const cached = cachedElevation(lat, lng);
    if (cached !== null) {
      el.textContent = ` ${Math.round(cached)}`;
      return;
    }
    void fetchElevation(lat, lng).then((alt) => {
      if (alt !== null && el.isConnected) el.textContent = ` ${Math.round(alt)}`;
    });
  });
}
