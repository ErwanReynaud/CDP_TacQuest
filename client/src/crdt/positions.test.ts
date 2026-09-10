// LWW-Register des positions.

import { describe, expect, it } from 'vitest';
import type { Position } from '@tq/shared/protocol';
import { PositionRegister } from './positions';

const T0 = 1_767_225_600_000;

const pos = (ts: number, lat = 45.1): Position => ({
  lat, lng: 5.7, accuracy: 5, heading: null, speed: null, ts,
});

describe('PositionRegister', () => {
  it('retient la position la plus récente', () => {
    const r = new PositionRegister();
    expect(r.apply('m1', pos(T0, 45.1))).toBe(true);
    expect(r.apply('m1', pos(T0 + 1000, 45.2))).toBe(true);
    expect(r.get('m1')!.lat).toBe(45.2);
  });

  it('rejette une position plus ancienne arrivée après', () => {
    // Sur un mesh, un paquet relayé arrive parfois après un plus récent :
    // comparer les heures de réception ferait gagner le chemin le plus lent.
    const r = new PositionRegister();
    r.apply('m1', pos(T0 + 1000, 45.2));
    expect(r.apply('m1', pos(T0, 45.1))).toBe(false);
    expect(r.get('m1')!.lat).toBe(45.2);
  });

  it('départage deux horodatages égaux de façon déterministe', () => {
    // Sans départage, deux nœuds recevant les mêmes positions dans un ordre
    // différent afficheraient durablement des valeurs différentes.
    const a = new PositionRegister();
    const b = new PositionRegister();
    a.apply('m1', pos(T0, 45.1), 10);
    a.apply('m1', pos(T0, 45.9), 20);
    b.apply('m1', pos(T0, 45.9), 20);
    b.apply('m1', pos(T0, 45.1), 10);
    expect(a.get('m1')!.lat).toBe(b.get('m1')!.lat);
    expect(a.get('m1')!.lat).toBe(45.9);
  });

  it('sépare les membres', () => {
    const r = new PositionRegister();
    r.apply('m1', pos(T0, 45.1));
    r.apply('m2', pos(T0, 46.1));
    expect(r.get('m1')!.lat).toBe(45.1);
    expect(r.get('m2')!.lat).toBe(46.1);
    expect(r.entries()).toHaveLength(2);
  });

  it('oublie les positions périmées', () => {
    // Une position périmée est pire qu'aucune : elle affiche un équipier là où
    // il n'est plus, avec l'apparence d'un point frais.
    const r = new PositionRegister();
    r.apply('vieux', pos(T0 - 600_000));
    r.apply('frais', pos(T0 - 1_000));
    expect(r.expire(T0, 300_000)).toEqual(['vieux']);
    expect(r.has('vieux')).toBe(false);
    expect(r.has('frais')).toBe(true);
  });

  it('supprime et vide', () => {
    const r = new PositionRegister();
    r.apply('m1', pos(T0));
    r.delete('m1');
    expect(r.get('m1')).toBeUndefined();
    r.apply('m2', pos(T0));
    r.clear();
    expect(r.entries()).toHaveLength(0);
  });
});
