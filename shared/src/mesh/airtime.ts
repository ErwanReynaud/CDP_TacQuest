// Temps d'occupation du canal (time on air) et budget de duty cycle.
//
// Sans ce calcul, rien ne relie le nombre d'octets qu'on émet au temps radio
// qu'ils coûtent réellement — or c'est ce temps, et non le volume, que la
// réglementation borne : 1 % en EU868, soit 36 secondes d'émission par heure
// glissante et par appareil.
//
// La formule est celle de Semtech (AN1200.13), utilisée par tous les calculateurs
// LoRa. Elle est exacte : ce qui est approximatif, ce sont les paramètres du
// préréglage, qu'il faut confirmer sur le module (cf. MESH_PRESETS).

/** Paramètres radio d'un préréglage LoRa. */
export interface LoRaParams {
  /** Facteur d'étalement, 7 à 12. */
  spreadingFactor: number;
  /** Largeur de bande en Hz. */
  bandwidthHz: number;
  /** Taux de codage : 1 pour 4/5, 2 pour 4/6, 3 pour 4/7, 4 pour 4/8. */
  codingRate: number;
  /** Symboles de préambule. */
  preambleSymbols: number;
  /** CRC de charge utile activé. */
  crc: boolean;
  /** En-tête implicite (rare ; Meshtastic utilise l'en-tête explicite). */
  implicitHeader: boolean;
}

/**
 * Préréglages Meshtastic courants.
 *
 * **À confirmer sur le matériel** : ces valeurs viennent de la documentation du
 * préréglage, pas d'une lecture du module. Le gouverneur s'en sert pour estimer
 * une durée ; une estimation trop haute freine plus que nécessaire, ce qui est
 * le sens sûr de l'erreur. Une lecture réelle via ADMIN_APP les remplacerait
 * avantageusement.
 */
export const MESH_PRESETS = {
  LongFast: { spreadingFactor: 11, bandwidthHz: 250_000, codingRate: 1, preambleSymbols: 16, crc: true, implicitHeader: false },
  MediumSlow: { spreadingFactor: 10, bandwidthHz: 250_000, codingRate: 1, preambleSymbols: 16, crc: true, implicitHeader: false },
  ShortFast: { spreadingFactor: 7, bandwidthHz: 250_000, codingRate: 1, preambleSymbols: 16, crc: true, implicitHeader: false },
} as const satisfies Record<string, LoRaParams>;

export type PresetName = keyof typeof MESH_PRESETS;

/** Durée d'un symbole, en millisecondes. */
export function symbolDurationMs(p: LoRaParams): number {
  return (2 ** p.spreadingFactor / p.bandwidthHz) * 1000;
}

/**
 * L'optimisation bas débit est requise quand un symbole dépasse 16 ms — sinon
 * la dérive d'horloge du récepteur devient sensible. Déduite plutôt que
 * configurée : c'est une conséquence des autres paramètres, pas un choix.
 */
export function lowDataRateOptimize(p: LoRaParams): boolean {
  return symbolDurationMs(p) > 16;
}

/**
 * Temps d'occupation du canal pour une charge utile donnée, en millisecondes.
 *
 * `payloadBytes` compte la trame LoRa complète, en-tête Meshtastic inclus — pas
 * seulement notre charge applicative.
 */
export function timeOnAirMs(payloadBytes: number, p: LoRaParams): number {
  const tSym = symbolDurationMs(p);
  const tPreamble = (p.preambleSymbols + 4.25) * tSym;
  const de = lowDataRateOptimize(p) ? 1 : 0;
  const numerator =
    8 * payloadBytes - 4 * p.spreadingFactor + 28 + (p.crc ? 16 : 0) - (p.implicitHeader ? 20 : 0);
  const denominator = 4 * (p.spreadingFactor - 2 * de);
  const symbols = 8 + Math.max(Math.ceil(numerator / denominator) * (p.codingRate + 4), 0);
  return tPreamble + symbols * tSym;
}

/**
 * Suivi du duty cycle sur une fenêtre glissante.
 *
 * Conserve les émissions de la dernière heure et refuse celles qui feraient
 * dépasser la fraction autorisée. Fenêtre **glissante** et non compteur remis à
 * zéro chaque heure : une rafale en fin de fenêtre ne doit pas ouvrir droit à
 * une seconde rafale immédiate.
 */
export class DutyCycleBudget {
  private readonly windowMs: number;
  private readonly budgetMs: number;
  private readonly sent: { at: number; ms: number }[] = [];

  /**
   * @param fraction part du temps autorisée (0,01 pour 1 % en EU868)
   * @param windowMs fenêtre d'observation, une heure par défaut
   */
  constructor(fraction: number, windowMs = 3_600_000) {
    this.windowMs = windowMs;
    this.budgetMs = windowMs * fraction;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.sent.length > 0 && this.sent[0]!.at <= cutoff) this.sent.shift();
  }

  /** Temps d'émission déjà consommé dans la fenêtre. */
  usedMs(now: number): number {
    this.prune(now);
    return this.sent.reduce((n, e) => n + e.ms, 0);
  }

  /** Temps encore disponible. */
  remainingMs(now: number): number {
    return Math.max(0, this.budgetMs - this.usedMs(now));
  }

  /** Une émission de cette durée tient-elle dans le budget ? */
  canSend(airtimeMs: number, now: number): boolean {
    return this.usedMs(now) + airtimeMs <= this.budgetMs;
  }

  /** Enregistre une émission effectuée. */
  record(airtimeMs: number, now: number): void {
    this.prune(now);
    this.sent.push({ at: now, ms: airtimeMs });
  }

  /** Part du budget consommée, de 0 à 1. */
  load(now: number): number {
    return this.budgetMs === 0 ? 1 : this.usedMs(now) / this.budgetMs;
  }

  /**
   * Instant auquel `airtimeMs` redeviendra émettable, ou `now` si c'est déjà
   * le cas. Sert à programmer la prochaine tentative plutôt qu'à sonder.
   */
  nextOpportunity(airtimeMs: number, now: number): number {
    if (this.canSend(airtimeMs, now)) return now;
    let freed = 0;
    const needed = this.usedMs(now) + airtimeMs - this.budgetMs;
    for (const e of this.sent) {
      freed += e.ms;
      if (freed >= needed) return e.at + this.windowMs;
    }
    // Même en vidant toute la fenêtre, l'émission ne tiendrait pas : elle
    // dépasse à elle seule le budget horaire.
    return Number.POSITIVE_INFINITY;
  }
}
