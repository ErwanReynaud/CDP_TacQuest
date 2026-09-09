import { describe, expect, it } from 'vitest';
import { forward as mgrsForward } from 'mgrs';
import { formatCoords, fromUtm, latitudeBand, parseCoords, toUtm, utmZone } from './coords';

// Notre UTM est validé par recoupement avec le paquet mgrs : dans un carré
// de 100 km, les chiffres MGRS sont l'easting/northing UTM modulo 100 000.
const SAMPLES: [string, number, number][] = [
  ['Grenoble', 45.1885, 5.7245],
  ['Brest', 48.39, -4.486],
  ['Sydney (hémisphère sud)', -33.8688, 151.2093],
  ['Oslo (exception Norvège z32)', 59.91, 5.5],
  ['Quito (équateur)', -0.18, -78.47],
];

describe('toUtm — recoupement avec la grille MGRS', () => {
  for (const [name, lat, lng] of SAMPLES) {
    it(name, () => {
      const utm = toUtm(lat, lng);
      const raw = mgrsForward([lng, lat], 5);
      const m = /^(\d{1,2})([C-X])([A-Z]{2})(\d{5})(\d{5})$/.exec(raw)!;
      expect(utm.zone).toBe(Number(m[1]));
      expect(utm.band).toBe(m[2]);
      expect(Math.floor(utm.easting) % 100000).toBeCloseTo(Number(m[4]), -1);
      expect(Math.floor(utm.northing) % 100000).toBeCloseTo(Number(m[5]), -1);
    });
  }
});

describe('fromUtm — réciproque de toUtm', () => {
  it('aller-retour < 1 m sur les échantillons', () => {
    for (const [, lat, lng] of SAMPLES) {
      const u = toUtm(lat, lng);
      const back = fromUtm(u.zone, u.easting, u.northing, lat < 0);
      // 1e-5° ≈ 1 m
      expect(Math.abs(back.lat - lat)).toBeLessThan(1e-5);
      expect(Math.abs(back.lng - lng)).toBeLessThan(1e-5);
    }
  });

  it('zone imposée : projection continue hors de la zone native', () => {
    // Point en zone 32 (7,2°E) projeté en zone 31 : l'aller-retour retombe juste.
    const u = toUtm(48.5, 7.2, 31);
    expect(u.zone).toBe(31);
    const back = fromUtm(31, u.easting, u.northing);
    expect(Math.abs(back.lat - 48.5)).toBeLessThan(1e-5);
    expect(Math.abs(back.lng - 7.2)).toBeLessThan(1e-5);
  });
});

describe('zones et bandes', () => {
  it('zone standard', () => expect(utmZone(45, 5.7)).toBe(31));
  it('exception sud-Norvège', () => expect(utmZone(60, 5)).toBe(32));
  it('exception Svalbard', () => expect(utmZone(78, 20)).toBe(33));
  it('bandes de latitude', () => {
    expect(latitudeBand(45.1)).toBe('T');
    expect(latitudeBand(-33.9)).toBe('H');
    expect(latitudeBand(60)).toBe('V');
  });
});

describe('formatage', () => {
  it('MGRS espacé', () => {
    expect(formatCoords(45.1885, 5.7245, 'mgrs')).toBe('31T GL 14026 07502');
  });
  it('UTM', () => {
    expect(formatCoords(45.1885, 5.7245, 'utm')).toMatch(/^31T \d{6} \d{7}$/);
  });
  it('géographique', () => {
    expect(formatCoords(45.1885, 5.7245, 'latlng')).toBe('45.18850°N 5.72450°E');
    expect(formatCoords(-33.8688, -70.6, 'latlng')).toBe('33.86880°S 70.60000°O');
  });
});

describe('parseCoords', () => {
  it('lat/lng décimal (virgule ou espace)', () => {
    expect(parseCoords('45.1885, 5.7245')).toEqual({ lat: 45.1885, lng: 5.7245 });
    expect(parseCoords('45.1885 5.7245')).toEqual({ lat: 45.1885, lng: 5.7245 });
  });
  it('lat/lng avec hémisphères N/S/E/O', () => {
    expect(parseCoords('33.8688S, 70.6O')).toEqual({ lat: -33.8688, lng: -70.6 });
    expect(parseCoords('45.1885°N 5.7245°E')).toEqual({ lat: 45.1885, lng: 5.7245 });
  });
  it('MGRS (round-trip avec le formatage)', () => {
    const p = parseCoords('31T GL 14026 07502');
    expect(p).not.toBeNull();
    expect(p!.lat).toBeCloseTo(45.1885, 2);
    expect(p!.lng).toBeCloseTo(5.7245, 2);
  });
  it('rejette une saisie invalide ou hors limites', () => {
    expect(parseCoords('')).toBeNull();
    expect(parseCoords('coucou')).toBeNull();
    expect(parseCoords('95, 200')).toBeNull();
  });
});
