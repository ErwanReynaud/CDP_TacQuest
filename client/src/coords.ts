import { forward as mgrsForward, toPoint as mgrsToPoint } from 'mgrs';
import { bus } from './state';

export type CoordFormat = 'mgrs' | 'utm' | 'latlng';

export const FORMAT_LABELS: Record<CoordFormat, string> = {
  mgrs: 'MGRS',
  utm: 'UTM',
  latlng: 'Géo',
};

const STORAGE_KEY = 'tq-coord-format';
const CYCLE: CoordFormat[] = ['mgrs', 'utm', 'latlng'];

const storage: Pick<Storage, 'getItem' | 'setItem'> =
  typeof localStorage !== 'undefined'
    ? localStorage
    : { getItem: () => null, setItem: () => {} };

let current: CoordFormat = (() => {
  const v = storage.getItem(STORAGE_KEY);
  return v === 'mgrs' || v === 'utm' || v === 'latlng' ? v : 'mgrs';
})();

export function getCoordFormat(): CoordFormat {
  return current;
}

export function setCoordFormat(f: CoordFormat): void {
  if (f === current) return;
  current = f;
  storage.setItem(STORAGE_KEY, f);
  bus.emit('coordfmt', f);
}

export function cycleCoordFormat(): void {
  setCoordFormat(CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length]!);
}

/**
 * Analyse une saisie de coordonnées et renvoie { lat, lng }, ou null si non
 * reconnu / hors limites. Accepte le lat/lng décimal (« 45.12, 5.34 », signes
 * ou suffixes N/S/E/O/W) et le MGRS (« 31U DQ 48774 43683 », espaces tolérés).
 */
export function parseCoords(input: string): { lat: number; lng: number } | null {
  const s = input.trim();
  if (!s) return null;
  const ll = parseLatLng(s);
  if (ll) return ll;
  // MGRS : au moins une lettre ; mgrs.toPoint lève si invalide.
  if (/[A-Za-z]/.test(s)) {
    try {
      const [lng, lat] = mgrsToPoint(s);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    } catch {
      return null;
    }
  }
  return null;
}

function parseLatLng(s: string): { lat: number; lng: number } | null {
  const m = /^([+-]?\d+(?:\.\d+)?)\s*°?\s*([NSns])?\s*[, ]\s*([+-]?\d+(?:\.\d+)?)\s*°?\s*([EWOewo])?$/.exec(s);
  if (!m) return null;
  let lat = parseFloat(m[1]!);
  let lng = parseFloat(m[3]!);
  if (m[2] && /[Ss]/.test(m[2])) lat = -lat;
  if (m[4] && /[OoWw]/.test(m[4])) lng = -lng;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/** Formate au format courant (ou explicite). */
export function formatCoords(lat: number, lng: number, fmt: CoordFormat = current): string {
  switch (fmt) {
    case 'mgrs':
      return formatMgrs(lat, lng);
    case 'utm':
      return formatUtm(lat, lng);
    case 'latlng':
      return formatLatLng(lat, lng);
  }
}

function formatLatLng(lat: number, lng: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'O';
  return `${Math.abs(lat).toFixed(5)}°${ns} ${Math.abs(lng).toFixed(5)}°${ew}`;
}

/** '31TGL1402607502' → '31T GL 14026 07502' (lisible à la radio). */
function formatMgrs(lat: number, lng: number): string {
  const raw = mgrsForward([lng, lat], 5);
  const m = /^(\d{1,2}[C-X])([A-Z]{2})(\d{10})$/.exec(raw);
  if (!m) return raw;
  return `${m[1]} ${m[2]} ${m[3]!.slice(0, 5)} ${m[3]!.slice(5)}`;
}

function formatUtm(lat: number, lng: number): string {
  const { zone, band, easting, northing } = toUtm(lat, lng);
  return `${zone}${band} ${Math.floor(easting)} ${Math.floor(northing)}`;
}

// ---------------------------------------------------------------------------
// Conversion UTM (WGS84, formules classiques de Snyder, précision < 1 m).
// Mêmes exceptions de zone (Norvège/Svalbard) que la grille MGRS.
// ---------------------------------------------------------------------------

export interface UtmCoords {
  zone: number;
  band: string;
  easting: number;
  northing: number;
}

const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

export function latitudeBand(lat: number): string {
  const i = Math.max(0, Math.min(19, Math.floor((lat + 80) / 8)));
  return BANDS[i]!;
}

export function utmZone(lat: number, lng: number): number {
  let zone = Math.floor((lng + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lng >= 3 && lng < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lng >= 0 && lng < 9) zone = 31;
    else if (lng >= 9 && lng < 21) zone = 33;
    else if (lng >= 21 && lng < 33) zone = 35;
    else if (lng >= 33 && lng < 42) zone = 37;
  }
  return zone;
}

/** `forcedZone` : projeter dans une zone imposée (grille continue au bord de
 *  zone — le quadrillage projette toute la vue dans la zone du centre). */
export function toUtm(lat: number, lng: number, forcedZone?: number): UtmCoords {
  const a = 6378137;
  const e2 = 0.00669438;
  const k0 = 0.9996;
  const zone = forcedZone ?? utmZone(lat, lng);
  const latR = (lat * Math.PI) / 180;
  const lngR = (lng * Math.PI) / 180;
  const lngOriginR = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const ep2 = e2 / (1 - e2);

  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const tanLat = Math.tan(latR);
  const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = ep2 * cosLat * cosLat;
  const A = cosLat * (lngR - lngOriginR);

  const M =
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * latR -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) * Math.sin(2 * latR) +
      ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * latR) -
      ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * latR));

  const easting =
    k0 *
      N *
      (A +
        ((1 - T + C) * A ** 3) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) +
    500000;

  let northing =
    k0 *
    (M +
      N *
        tanLat *
        (A ** 2 / 2 +
          ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;

  return { zone, band: latitudeBand(lat), easting, northing };
}

/** Conversion inverse UTM → lat/lng (Snyder, réciproque de toUtm, < 1 m). */
export function fromUtm(
  zone: number,
  easting: number,
  northing: number,
  southern = false,
): { lat: number; lng: number } {
  const a = 6378137;
  const e2 = 0.00669438;
  const k0 = 0.9996;
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));

  const x = easting - 500000;
  const y = southern ? northing - 10000000 : northing;

  const mu =
    y / k0 / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);

  const sinP = Math.sin(phi1);
  const cosP = Math.cos(phi1);
  const tanP = Math.tan(phi1);
  const C1 = ep2 * cosP * cosP;
  const T1 = tanP * tanP;
  const N1 = a / Math.sqrt(1 - e2 * sinP * sinP);
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinP * sinP, 1.5);
  const D = x / (N1 * k0);

  const latR =
    phi1 -
    ((N1 * tanP) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lngR =
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) /
    cosP;

  const lngOrigin = (zone - 1) * 6 - 180 + 3;
  return { lat: (latR * 180) / Math.PI, lng: lngOrigin + (lngR * 180) / Math.PI };
}
