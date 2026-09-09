import { describe, expect, it } from 'vitest';
import { MISSION_CATEGORIES, MISSIONS, missionDef } from './missionCatalog';

describe('catalogue des missions', () => {
  it('ids uniques, niveaux et aperçus renseignés', () => {
    const ids = MISSIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MISSIONS) {
      expect(m.levels.length).toBeGreaterThan(0);
      expect(m.preview).not.toBe('');
      expect(m.abbr).not.toBe('');
      expect(MISSION_CATEGORIES[m.cat]).toBeDefined();
    }
  });

  it('couvre les missions section et groupe des planches', () => {
    const of = (level: 'section' | 'groupe') =>
      MISSIONS.filter((m) => m.levels.includes(level)).map((m) => m.id).sort();
    // Section : 5 offensives (APP en deux variantes : trapèze + flèche)
    // + 4 défensives figurées (Relever : pas de symbole) + 5 sûreté.
    expect(of('section')).toEqual(
      ['semp', 'app', 'appf', 'sout', 'neut', 'fix', 'interd', 'def', 'ten', 'recu', 'ecl', 'reco', 'couv', 'boucl', 'surv'].sort(),
    );
    // Groupe : s'EMP / NEUT / DET / COUV / APP (2 variantes) / SURV / TEN / RECO / ECL.
    expect(of('groupe')).toEqual(
      ['semp', 'neut', 'det', 'couv', 'app', 'appf', 'surv', 'ten', 'reco', 'ecl'].sort(),
    );
  });

  it('missionDef retrouve un id et ignore un id inconnu', () => {
    expect(missionDef('fix')?.name).toBe('Fixer');
    expect(missionDef('nimporte')).toBeUndefined();
  });
});
