// Vecteur de versions : ce que ce nœud détient, par auteur.
//
// Sert aux deux sens de l'anti-entropie (docs/mesh/protocol.md § 6.3) :
//   - ce qu'on annonce aux autres (le plus haut numéro **contigu** détenu) ;
//   - ce qu'on sait nous manquer (les trous internes), qu'on ira demander.
//
// Les numéros de séquence d'un auteur sont stockés en intervalles fusionnés
// plutôt qu'en ensemble de valeurs : une session produit des séquences
// quasi-continues, donc quelques intervalles suffisent là où un Set garderait
// des milliers d'entrées, et les trous se lisent directement entre eux.

/** Intervalle inclusif de numéros de séquence. */
export interface SeqRange {
  from: number;
  to: number;
}

/** Plage manquante, telle qu'on la demandera par une trame REQ. */
export interface Gap {
  node: number;
  from: number;
  count: number;
}

export class VersionVector {
  private readonly byNode = new Map<number, SeqRange[]>();

  /** Enregistre la détention d'un numéro de séquence pour un auteur. */
  add(node: number, seq: number): void {
    const ranges = this.byNode.get(node);
    if (!ranges) {
      this.byNode.set(node, [{ from: seq, to: seq }]);
      return;
    }
    // Insertion en gardant les intervalles triés, disjoints et fusionnés.
    let i = 0;
    while (i < ranges.length && ranges[i]!.to < seq - 1) i++;
    if (i === ranges.length) {
      ranges.push({ from: seq, to: seq });
      return;
    }
    const r = ranges[i]!;
    if (seq >= r.from && seq <= r.to) return; // déjà détenu
    if (seq === r.from - 1) {
      r.from = seq;
    } else if (seq === r.to + 1) {
      r.to = seq;
      // Le voisin de droite peut maintenant être collé : on fusionne.
      const next = ranges[i + 1];
      if (next && next.from === r.to + 1) {
        r.to = next.to;
        ranges.splice(i + 1, 1);
      }
    } else {
      ranges.splice(i, 0, { from: seq, to: seq });
    }
  }

  has(node: number, seq: number): boolean {
    return (this.byNode.get(node) ?? []).some((r) => seq >= r.from && seq <= r.to);
  }

  /**
   * Plus haut numéro détenu **sans trou** depuis le plus bas connu.
   *
   * C'est cette valeur qu'on annonce : un pair qui détient au-delà sait quoi
   * nous réémettre. Les trous internes, eux, sont invisibles pour lui — c'est
   * à nous de les demander (cf. `gaps`).
   */
  contiguousUpto(node: number): number | null {
    const first = this.byNode.get(node)?.[0];
    return first ? first.to : null;
  }

  /** Plus haut numéro détenu, trous compris. */
  highest(node: number): number | null {
    const ranges = this.byNode.get(node);
    return ranges && ranges.length > 0 ? ranges[ranges.length - 1]!.to : null;
  }

  /** Trous internes, dans l'ordre, pour tous les auteurs connus. */
  gaps(): Gap[] {
    const out: Gap[] = [];
    for (const [node, ranges] of this.byNode) {
      for (let i = 0; i + 1 < ranges.length; i++) {
        const from = ranges[i]!.to + 1;
        const count = ranges[i + 1]!.from - from;
        out.push({ node, from, count });
      }
    }
    return out;
  }

  /** Auteurs connus, pour composer un digest. */
  nodes(): number[] {
    return [...this.byNode.keys()];
  }

  /** Entrées de digest : un couple (auteur, plus haut contigu) par auteur. */
  digestEntries(): { node: number; upto: number }[] {
    const out: { node: number; upto: number }[] = [];
    for (const node of this.byNode.keys()) {
      const upto = this.contiguousUpto(node);
      if (upto !== null) out.push({ node, upto });
    }
    return out;
  }

  /** Numéros détenus pour un auteur, au-delà d'un seuil. Bornée par `limit`. */
  heldAbove(node: number, seq: number, limit: number): number[] {
    const out: number[] = [];
    for (const r of this.byNode.get(node) ?? []) {
      for (let s = Math.max(r.from, seq + 1); s <= r.to && out.length < limit; s++) {
        out.push(s);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Retire un numéro, après compaction du magasin d'ordres. */
  remove(node: number, seq: number): void {
    const ranges = this.byNode.get(node);
    if (!ranges) return;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!;
      if (seq < r.from || seq > r.to) continue;
      if (r.from === r.to) ranges.splice(i, 1);
      else if (seq === r.from) r.from++;
      else if (seq === r.to) r.to--;
      else {
        // Scission : le numéro retiré est au milieu d'un intervalle.
        ranges.splice(i + 1, 0, { from: seq + 1, to: r.to });
        r.to = seq - 1;
      }
      break;
    }
    if (ranges.length === 0) this.byNode.delete(node);
  }

  /** Intervalles détenus pour un auteur. Réservé aux tests et au diagnostic. */
  rangesOf(node: number): SeqRange[] {
    return (this.byNode.get(node) ?? []).map((r) => ({ ...r }));
  }
}
