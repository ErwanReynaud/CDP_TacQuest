// LWW-Register des positions.
//
// Conception : docs/mesh/protocol.md § 6.1.
//
// Une position par membre, dernier écrit gagne. Les positions ne sont pas
// journalisées : seule la plus récente compte, et une position perdue est
// remplacée au fix suivant. C'est ce qui permet de les jeter sans remords quand
// l'airtime manque — contrairement aux figurés, qui doivent tous arriver.

import type { Position } from '@tq/shared/protocol';

interface Stamped {
  position: Position;
  /** Départage deux positions de même horodatage. */
  origin: number;
}

/**
 * Registre des dernières positions connues.
 *
 * Le comparateur est l'horodatage du fix GPS, et non l'heure de réception :
 * sur un mesh, un paquet peut être relayé avec plusieurs secondes de retard, et
 * comparer les heures d'arrivée ferait gagner le chemin le plus lent.
 */
export class PositionRegister {
  private readonly byMember = new Map<string, Stamped>();

  /**
   * Applique une position. Renvoie `true` si elle a remplacé la précédente.
   *
   * À horodatage égal, le plus grand `origin` (numéro de nœud) l'emporte. Ce
   * départage est arbitraire mais **déterministe** : sans lui, deux nœuds
   * recevant les mêmes positions dans un ordre différent afficheraient
   * durablement des valeurs différentes.
   */
  apply(memberId: string, position: Position, origin = 0): boolean {
    const current = this.byMember.get(memberId);
    if (current) {
      if (position.ts < current.position.ts) return false;
      if (position.ts === current.position.ts && origin <= current.origin) return false;
    }
    this.byMember.set(memberId, { position, origin });
    return true;
  }

  get(memberId: string): Position | undefined {
    return this.byMember.get(memberId)?.position;
  }

  has(memberId: string): boolean {
    return this.byMember.has(memberId);
  }

  delete(memberId: string): void {
    this.byMember.delete(memberId);
  }

  clear(): void {
    this.byMember.clear();
  }

  entries(): [string, Position][] {
    return [...this.byMember].map(([id, s]) => [id, s.position]);
  }

  /**
   * Oublie les positions plus vieilles que `maxAgeMs`.
   *
   * Une position périmée est pire qu'aucune position : elle affiche un équipier
   * là où il n'est plus, avec la même apparence qu'un point frais. Le libellé
   * d'ancienneté du tiroir atténue, mais le marqueur sur la carte, lui, ment.
   */
  expire(now: number, maxAgeMs: number): string[] {
    const dropped: string[] = [];
    for (const [id, s] of this.byMember) {
      if (now - s.position.ts > maxAgeMs) {
        this.byMember.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }
}
