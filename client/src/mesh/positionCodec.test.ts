// Conversion Position TacQuest ↔ Meshtastic.

import { create, fromBinary } from '@bufbuild/protobuf';
import { Protobuf } from '@meshtastic/core';
import { describe, expect, it } from 'vitest';
import type { Position } from '@tq/shared/protocol';
import { decodePosition, encodePosition, fromMeshPosition } from './positionCodec';

const RX = new Date('2026-01-01T12:00:00Z');

const FIX: Position = {
  lat: 45.123456,
  lng: 5.654321,
  accuracy: 4.7,
  heading: 271.5,
  speed: 3,
  ts: 1_767_225_600_000,
};

describe('encodePosition', () => {
  it('fait l’aller-retour sans perte sensible', () => {
    const back = decodePosition(encodePosition(FIX), RX)!;
    expect(back).not.toBeNull();
    // 1e-7 degré ≈ 1 cm : bien en deçà de la précision GPS.
    expect(back.lat).toBeCloseTo(FIX.lat, 6);
    expect(back.lng).toBeCloseTo(FIX.lng, 6);
    expect(back.accuracy).toBeCloseTo(FIX.accuracy, 2);
    expect(back.heading).toBeCloseTo(FIX.heading!, 4);
    expect(back.speed).toBe(3);
    expect(back.ts).toBe(FIX.ts);
  });

  it('tient largement dans une trame LoRa', () => {
    expect(encodePosition(FIX).length).toBeLessThan(60);
  });

  it('marque la position comme externe au module', () => {
    // Le fix vient du GPS du téléphone, pas du récepteur du module : la
    // distinction est visible depuis un client Meshtastic standard.
    const m = fromBinary(Protobuf.Mesh.PositionSchema, encodePosition(FIX));
    expect(m.locationSource).toBe(Protobuf.Mesh.Position_LocSource.LOC_EXTERNAL);
  });

  it('omet cap et vitesse quand ils sont absents', () => {
    const noMotion: Position = { ...FIX, heading: null, speed: null };
    const back = decodePosition(encodePosition(noMotion), RX)!;
    expect(back.heading).toBeNull();
    expect(back.speed).toBeNull();
  });
});

describe('fromMeshPosition', () => {
  it('ignore une position nulle (nœud sans fix)', () => {
    // Meshtastic diffuse du 0/0 avant acquisition : afficher ce point placerait
    // un équipier dans le golfe de Guinée.
    const empty = create(Protobuf.Mesh.PositionSchema, { latitudeI: 0, longitudeI: 0 });
    expect(fromMeshPosition(empty, RX)).toBeNull();
  });

  it('survit à un nœud qui n’envoie que la latitude et la longitude', () => {
    // Tous les champs sont optionnels en proto3 : diviser un champ absent
    // donnerait NaN, et un marqueur en NaN/NaN disparaît sans erreur.
    const minimal = create(Protobuf.Mesh.PositionSchema, {
      latitudeI: 451234560,
      longitudeI: 56543210,
    });
    const p = fromMeshPosition(minimal, RX)!;
    expect(Number.isFinite(p.lat)).toBe(true);
    expect(Number.isFinite(p.lng)).toBe(true);
    expect(Number.isFinite(p.accuracy)).toBe(true);
    expect(p.heading).toBeNull();
    expect(p.speed).toBeNull();
    // Sans horodatage du nœud, on retombe sur l'heure de réception.
    expect(p.ts).toBe(RX.getTime());
  });

  it('annonce une précision pessimiste plutôt qu’un faux zéro', () => {
    const noAcc = create(Protobuf.Mesh.PositionSchema, {
      latitudeI: 451234560,
      longitudeI: 56543210,
      gpsAccuracy: 0,
    });
    expect(fromMeshPosition(noAcc, RX)!.accuracy).toBeGreaterThan(10);
  });

  it('accepte les latitudes et longitudes négatives', () => {
    const south: Position = { ...FIX, lat: -33.8688, lng: -70.6693 };
    const back = decodePosition(encodePosition(south), RX)!;
    expect(back.lat).toBeCloseTo(south.lat, 6);
    expect(back.lng).toBeCloseTo(south.lng, 6);
  });
});
