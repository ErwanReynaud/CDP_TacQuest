// Vecteur de versions : intervalles, contiguïté, trous.

import { describe, expect, it } from 'vitest';
import { VersionVector } from './versionVector';

const N = 0x11;

describe('VersionVector', () => {
  it('fusionne les numéros consécutifs en un seul intervalle', () => {
    const v = new VersionVector();
    for (const s of [1, 2, 3]) v.add(N, s);
    expect(v.rangesOf(N)).toEqual([{ from: 1, to: 3 }]);
    expect(v.contiguousUpto(N)).toBe(3);
  });

  it('fusionne quel que soit l’ordre d’arrivée', () => {
    // Sur un mesh les paquets arrivent dans le désordre : 3 puis 1 puis 2 doit
    // donner le même résultat que 1, 2, 3.
    const v = new VersionVector();
    for (const s of [3, 1, 2]) v.add(N, s);
    expect(v.rangesOf(N)).toEqual([{ from: 1, to: 3 }]);
  });

  it('recolle deux intervalles quand le numéro manquant arrive', () => {
    const v = new VersionVector();
    for (const s of [1, 2, 5, 6]) v.add(N, s);
    expect(v.rangesOf(N)).toEqual([{ from: 1, to: 2 }, { from: 5, to: 6 }]);
    v.add(N, 4);
    v.add(N, 3);
    expect(v.rangesOf(N)).toEqual([{ from: 1, to: 6 }]);
  });

  it('ignore un doublon', () => {
    const v = new VersionVector();
    v.add(N, 7);
    v.add(N, 7);
    expect(v.rangesOf(N)).toEqual([{ from: 7, to: 7 }]);
  });

  it('n’annonce que le contigu, pas le plus haut détenu', () => {
    // Distinction essentielle : annoncer 9 alors qu'il manque 3 et 4 ferait
    // croire aux pairs qu'on est à jour, et personne ne réémettrait les trous.
    const v = new VersionVector();
    for (const s of [1, 2, 5, 9]) v.add(N, s);
    expect(v.contiguousUpto(N)).toBe(2);
    expect(v.highest(N)).toBe(9);
  });

  it('énumère les trous internes tels qu’on les demandera', () => {
    const v = new VersionVector();
    for (const s of [1, 2, 5, 6, 10]) v.add(N, s);
    expect(v.gaps()).toEqual([
      { node: N, from: 3, count: 2 },
      { node: N, from: 7, count: 3 },
    ]);
  });

  it('ne voit aucun trou dans une séquence continue', () => {
    const v = new VersionVector();
    for (const s of [4, 5, 6]) v.add(N, s);
    expect(v.gaps()).toEqual([]);
  });

  it('sépare les auteurs', () => {
    const v = new VersionVector();
    v.add(0x11, 1);
    v.add(0x22, 5);
    expect(v.contiguousUpto(0x11)).toBe(1);
    expect(v.contiguousUpto(0x22)).toBe(5);
    expect(v.nodes().sort()).toEqual([0x11, 0x22]);
    expect(v.digestEntries()).toEqual([
      { node: 0x11, upto: 1 },
      { node: 0x22, upto: 5 },
    ]);
  });

  it('liste ce qu’on détient au-delà d’un seuil annoncé', () => {
    const v = new VersionVector();
    for (const s of [1, 2, 3, 7, 8]) v.add(N, s);
    expect(v.heldAbove(N, 2, 10)).toEqual([3, 7, 8]);
    expect(v.heldAbove(N, 8, 10)).toEqual([]);
    // Bornée : une réémission ne doit pas saturer le canal.
    expect(v.heldAbove(N, 0, 2)).toEqual([1, 2]);
  });

  it('retire un numéro, y compris au milieu d’un intervalle', () => {
    const v = new VersionVector();
    for (const s of [1, 2, 3, 4]) v.add(N, s);
    v.remove(N, 3);
    expect(v.rangesOf(N)).toEqual([{ from: 1, to: 2 }, { from: 4, to: 4 }]);
    v.remove(N, 1);
    expect(v.rangesOf(N)).toEqual([{ from: 2, to: 2 }, { from: 4, to: 4 }]);
  });

  it('oublie un auteur dont tout a été retiré', () => {
    const v = new VersionVector();
    v.add(N, 1);
    v.remove(N, 1);
    expect(v.nodes()).toEqual([]);
    expect(v.contiguousUpto(N)).toBeNull();
  });

  it('reste compact sur une longue séquence continue', () => {
    // 500 ordres d'un même auteur : un seul intervalle, pas 500 entrées.
    const v = new VersionVector();
    for (let s = 0; s < 500; s++) v.add(N, s);
    expect(v.rangesOf(N)).toHaveLength(1);
    expect(v.contiguousUpto(N)).toBe(499);
  });
});
