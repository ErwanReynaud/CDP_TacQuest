// Tests de la quantification des coordonnées.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalAnchor,
  decodeOffset,
  encodeOffset,
  MAX_ABS_LAT,
  metresPerDegLat,
  metresPerDegLng,
  withinAnchor,
} from '../src/mesh/geo.ts';
import { ANCHOR_RANGE_M } from '../src/mesh/constants.ts';

const ANCHOR = { lat: 45.0, lng: 5.0 };

/** Erreur d'aller-retour en mètres sur chaque axe. */
function roundTripErrorM(anchor: { lat: number; lng: number }, lat: number, lng: number) {
  const off = encodeOffset(anchor, lat, lng);
  assert.ok(off, 'point attendu dans l’enveloppe');
  const back = decodeOffset(anchor, off);
  return {
    n: Math.abs(back.lat - lat) * metresPerDegLat(lat),
    e: Math.abs(back.lng - lng) * metresPerDegLng(lat),
  };
}

test('échelles WGS84 aux valeurs de référence', () => {
  // Valeurs classiques : ~110,57 km/° de latitude à l'équateur, ~111,69 au pôle.
  assert.ok(Math.abs(metresPerDegLat(0) - 110574) < 60, `${metresPerDegLat(0)}`);
  assert.ok(Math.abs(metresPerDegLat(90) - 111694) < 60, `${metresPerDegLat(90)}`);
  assert.ok(Math.abs(metresPerDegLng(0) - 111320) < 60, `${metresPerDegLng(0)}`);
  assert.ok(metresPerDegLng(90) < 1, 'la longitude s’effondre au pôle');
});

test('aller-retour sous le mètre partout dans l’enveloppe', () => {
  const pts: [number, number][] = [
    [45.0, 5.0],       // ancre
    [45.29, 5.4],      // NE extrême
    [44.71, 4.6],      // SO extrême
    [45.29, 4.6],      // NO extrême
    [44.71, 5.4],      // SE extrême
    [45.0001, 5.0001], // très proche
  ];
  for (const [lat, lng] of pts) {
    const err = roundTripErrorM(ANCHOR, lat, lng);
    assert.ok(err.n < 1, `erreur nord ${err.n} m en ${lat},${lng}`);
    assert.ok(err.e < 1, `erreur est ${err.e} m en ${lat},${lng}`);
  }
});

test('l’échelle en longitude suit la latitude du point, pas celle de l’ancre', () => {
  // Sans cette correction, un point à ~32 km à l'est et 0,3° au nord d'une
  // ancre à 45° dérive de plus de 100 m.
  const err = roundTripErrorM(ANCHOR, 45.28, 5.4);
  assert.ok(err.e < 1, `erreur est ${err.e} m — l’échelle de l’ancre a été utilisée`);
});

test('l’aller-retour est stable sous plusieurs cycles', () => {
  let lat = 45.1234;
  let lng = 5.2345;
  for (let i = 0; i < 5; i++) {
    const back = decodeOffset(ANCHOR, encodeOffset(ANCHOR, lat, lng)!);
    if (i > 0) {
      assert.equal(back.lat, lat, 'la latitude doit être un point fixe');
      assert.equal(back.lng, lng, 'la longitude doit être un point fixe');
    }
    lat = back.lat;
    lng = back.lng;
  }
});

test('hors enveloppe : refus explicite, jamais de troncature', () => {
  assert.equal(encodeOffset(ANCHOR, 46.0, 5.0), null, '~111 km au nord');
  assert.equal(encodeOffset(ANCHOR, 45.0, 6.0), null, '~79 km à l’est');
  assert.equal(withinAnchor(ANCHOR, 46.0, 5.0), false);
  assert.equal(withinAnchor(ANCHOR, 45.2, 5.2), true);
});

test('la limite d’enveloppe correspond bien à ANCHOR_RANGE_M', () => {
  const justIn = ANCHOR.lat + (ANCHOR_RANGE_M - 5) / metresPerDegLat(ANCHOR.lat);
  const justOut = ANCHOR.lat + (ANCHOR_RANGE_M + 50) / metresPerDegLat(ANCHOR.lat);
  assert.ok(encodeOffset(ANCHOR, justIn, 5.0), 'juste dedans');
  assert.equal(encodeOffset(ANCHOR, justOut, 5.0), null, 'juste dehors');
});

test('les hautes latitudes sont refusées', () => {
  const polar = { lat: MAX_ABS_LAT + 1, lng: 0 };
  assert.equal(encodeOffset(polar, MAX_ABS_LAT + 1, 0), null);
  assert.equal(encodeOffset({ lat: 0, lng: 0 }, MAX_ABS_LAT + 1, 0), null);
});

test('l’ancre canonique regroupe les départs proches…', () => {
  const a = canonicalAnchor(45.0123, 5.0412);
  const b = canonicalAnchor(45.0134, 5.0441);
  assert.deepEqual(a, b, 'même case de 0,01° → aucune renégociation');
  assert.deepEqual(a, { lat: 45.01, lng: 5.04 });
});

test('…mais deux nœuds de part et d’autre d’une frontière divergent', () => {
  // Limitation inhérente à tout arrondi : 130 m d'écart suffisent à basculer
  // dans la case voisine. L'arrondi réduit la fréquence des désaccords, il ne
  // les supprime pas — c'est la trame ANCHOR qui tranche (cf. protocol.md § 3).
  const a = canonicalAnchor(45.0123, 5.0441);
  const b = canonicalAnchor(45.0123, 5.0456);
  assert.notDeepEqual(a, b);
  assert.deepEqual(a, { lat: 45.01, lng: 5.04 });
  assert.deepEqual(b, { lat: 45.01, lng: 5.05 });
});

test('fonctionne aussi près de l’équateur et sur l’antiméridien', () => {
  for (const anchor of [{ lat: 0.0, lng: 0.0 }, { lat: -33.9, lng: 151.2 }, { lat: 60.0, lng: -140.0 }]) {
    const err = roundTripErrorM(anchor, anchor.lat + 0.2, anchor.lng + 0.2);
    assert.ok(err.n < 1 && err.e < 1, `${JSON.stringify(anchor)} : ${err.n}/${err.e} m`);
  }
});
