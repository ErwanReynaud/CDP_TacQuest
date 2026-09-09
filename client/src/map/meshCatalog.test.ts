// Garde anti-dérive entre les dictionnaires du protocole mesh et l'UI.
//
// Sur le fil, une mission et un SIDC sont des index. Si le catalogue client et
// la table de référence divergent, deux nœuds affichent un figuré différent
// pour le même octet — sans qu'aucune erreur ne soit levée. Ces tests
// transforment cette dérive silencieuse en échec de CI.

import { describe, expect, it } from 'vitest';
import { MESH_MISSION_IDS, MESH_SIDC_DICT, MESH_PALETTE } from '@tq/shared/mesh/constants';
import { MISSIONS } from './missionCatalog';
import { HOSTILE_SIDC } from '@tq/shared/constants';

describe('dictionnaires mesh ↔ catalogue client', () => {
  it('couvre exactement les missions du catalogue', () => {
    expect([...MESH_MISSION_IDS].sort()).toEqual(MISSIONS.map((m) => m.id).sort());
  });

  it('n’a aucun doublon d’index de mission', () => {
    expect(new Set(MESH_MISSION_IDS).size).toBe(MESH_MISSION_IDS.length);
  });

  it('tient les index de mission sur un octet', () => {
    // 0xFF est réservé à « mission inconnue » (rendu en ligne simple).
    expect(MESH_MISSION_IDS.length).toBeLessThan(0xff);
  });

  it('réserve l’index SIDC 0 au plot ENI', () => {
    expect(MESH_SIDC_DICT[0]).toBe(HOSTILE_SIDC);
  });

  it('tient les index de couleur sur 4 bits', () => {
    expect(MESH_PALETTE.length).toBe(16);
    expect(new Set(MESH_PALETTE).size).toBe(16);
  });

  it('inclut les couleurs réellement câblées dans l’UI', () => {
    // Ces trois-là doivent survivre à l'aller-retour sans être approximées :
    // défaut des outils, doctrine ami, tracé de mesure.
    for (const c of ['#e8d44d', '#0033ff', '#d9a13b']) {
      expect(MESH_PALETTE).toContain(c);
    }
  });
});
