// Mise en forme du diagnostic radio.
//
// Ce bloc est ce qu'un opérateur lit sur le terrain pour décider quoi faire.
// Les tests portent donc surtout sur le diagnostic en une phrase : c'est lui
// qui oriente l'action, les chiffres ne servent qu'à l'étayer.

import { describe, expect, it } from 'vitest';
import type { MeshStats } from '../transport/meshTransport';
import { formatMeshStats } from './meshDiag';

function stats(over: Partial<MeshStats> = {}): MeshStats {
  return {
    status: 'connected',
    nodeNum: 0xa4f2c810,
    anchor: { lat: 45.01, lng: 5.04 },
    rx: { frames: 12, bytes: 340, orders: 5, positions: 6, errors: 0 },
    tx: {
      frames: 8,
      bytes: 210,
      byKind: { order: 3, relay: 1, digest: 2, req: 0, anchor: 1, position: 1, control: 0 },
    },
    sync: { authors: 3, scheduled: 0, gaps: 0, requests: 0 },
    airtime: { queued: 0, dropped: 0, load: 0.2, usedMs: 7_200, remainingMs: 28_800 },
    lastError: null,
    ...over,
  };
}

describe('formatMeshStats', () => {
  it('annonce clairement l’absence de module', () => {
    const out = formatMeshStats(null);
    expect(out).toMatch(/Aucun module radio/);
    expect(out).toMatch(/serveur/);
  });

  it('affiche le nœud en hexadécimal, comme les identifiants d’ordre', () => {
    expect(formatMeshStats(stats())).toMatch(/a4f2c810/);
  });

  it('conclut au lien nominal quand tout va bien', () => {
    expect(formatMeshStats(stats())).toMatch(/Lien nominal/);
  });
});

describe('le diagnostic oriente vers la bonne cause', () => {
  it('module non connecté', () => {
    expect(formatMeshStats(stats({ status: 'connecting' }))).toMatch(/non connecté/);
  });

  it('rien reçu : portée, ou canal et clé différents', () => {
    const out = formatMeshStats(
      stats({ rx: { frames: 0, bytes: 0, orders: 0, positions: 0, errors: 0 } }),
    );
    expect(out).toMatch(/Aucune trame reçue/);
    expect(out).toMatch(/canal et clé/);
  });

  it('distingue « ça arrive mais c’est illisible » de « rien n’arrive »', () => {
    // Cas piégeux : la radio marche, c'est l'application qui ne suit pas.
    // Sans cette distinction, on chercherait un problème de portée.
    const out = formatMeshStats(
      stats({ rx: { frames: 9, bytes: 200, orders: 0, positions: 0, errors: 9 } }),
    );
    expect(out).toMatch(/aucune n’est décodable/);
    expect(out).toMatch(/même version/);
  });

  it('signale l’attente d’un premier point GPS', () => {
    expect(formatMeshStats(stats({ anchor: null }))).toMatch(/ancre de zone/);
  });

  it('signale un rattrapage en cours avec le nombre de trous', () => {
    const out = formatMeshStats(stats({ sync: { authors: 3, scheduled: 2, gaps: 4, requests: 1 } }));
    expect(out).toMatch(/Rattrapage en cours : 4 trou/);
  });

  it('alerte quand le budget radio est presque épuisé', () => {
    // Le duty cycle est légal, pas indicatif : passé le seuil, le module
    // refuse d'émettre. Mieux vaut que l'opérateur le sache.
    const out = formatMeshStats(
      stats({ airtime: { queued: 5, dropped: 1, load: 0.95, usedMs: 34_200, remainingMs: 1_800 } }),
    );
    expect(out).toMatch(/Budget radio presque épuisé/);
    expect(out).toMatch(/95 %/);
  });

  it('reporte la dernière trame rejetée avec sa cause', () => {
    const out = formatMeshStats(stats({ lastError: 'de 11 : version de protocole 2 non gérée' }));
    expect(out).toMatch(/version de protocole 2/);
  });
});

describe('lisibilité', () => {
  it('abrège les gros volumes', () => {
    const out = formatMeshStats(
      stats({ rx: { frames: 900, bytes: 45_600, orders: 400, positions: 500, errors: 0 } }),
    );
    expect(out).toMatch(/45\.6 ko/);
  });

  it('garde les petits volumes en octets', () => {
    expect(formatMeshStats(stats())).toMatch(/340 o/);
  });

  it('détaille les émissions par nature', () => {
    const out = formatMeshStats(stats());
    for (const label of ['ordres', 'relais', 'positions', 'digests', 'demandes']) {
      expect(out).toContain(label);
    }
  });
});
