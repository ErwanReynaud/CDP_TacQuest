// Temps d'occupation du canal et budget de duty cycle.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  DutyCycleBudget,
  lowDataRateOptimize,
  MESH_PRESETS,
  symbolDurationMs,
  timeOnAirMs,
} from '../src/mesh/airtime';

/** Référence classique des calculateurs LoRa : SF7, 125 kHz, 4/5, 8 symboles. */
const REF = {
  spreadingFactor: 7,
  bandwidthHz: 125_000,
  codingRate: 1,
  preambleSymbols: 8,
  crc: true,
  implicitHeader: false,
};

test('reproduit la valeur de référence SF7/125 kHz/4-5', () => {
  // 20 octets à ces paramètres valent ~56,6 ms, valeur publiée par Semtech et
  // reprise par tous les calculateurs en ligne.
  const toa = timeOnAirMs(20, REF);
  assert.ok(Math.abs(toa - 56.6) < 0.5, `${toa.toFixed(2)} ms attendu ≈ 56,6 ms`);
});

test('la durée de symbole suit 2^SF / BW', () => {
  assert.equal(symbolDurationMs(REF), 1.024);
  assert.ok(Math.abs(symbolDurationMs(MESH_PRESETS.LongFast) - 8.192) < 1e-9);
});

test('l’optimisation bas débit s’active au-delà de 16 ms par symbole', () => {
  // Conséquence des paramètres, pas un réglage : SF12 en 125 kHz la déclenche,
  // SF11 en 250 kHz non.
  assert.equal(lowDataRateOptimize({ ...REF, spreadingFactor: 12 }), true);
  assert.equal(lowDataRateOptimize(MESH_PRESETS.LongFast), false);
});

test('le temps croît avec la charge utile', () => {
  const p = MESH_PRESETS.LongFast;
  assert.ok(timeOnAirMs(200, p) > timeOnAirMs(50, p));
  assert.ok(timeOnAirMs(50, p) > timeOnAirMs(10, p));
});

test('un préréglage plus lent coûte plus cher', () => {
  assert.ok(timeOnAirMs(100, MESH_PRESETS.LongFast) > timeOnAirMs(100, MESH_PRESETS.ShortFast));
});

test('une trame pleine en LongFast coûte près de deux secondes', () => {
  // Le chiffre qui conditionne tout le dimensionnement, et qui justifie à lui
  // seul l'existence du gouverneur : à ce prix, 36 s de budget horaire
  // n'autorisent qu'une vingtaine de trames pleines. Compter en octets, comme
  // on le faisait jusqu'ici, masquait complètement cette limite.
  const toa = timeOnAirMs(216, MESH_PRESETS.LongFast); // 200 utiles + en-tête
  assert.ok(toa > 1_500 && toa < 2_000, `${toa.toFixed(0)} ms`);
  assert.ok(Math.floor(36_000 / toa) < 25, 'moins de 25 trames pleines par heure');
});

test('même une trame courte coûte des centaines de millisecondes', () => {
  // Le préambule (16 symboles à 8,192 ms) domine : une trame minuscule ne
  // coûte pas beaucoup moins cher qu'une trame moyenne. D'où l'intérêt de
  // grouper plutôt que de multiplier les petits envois.
  const plot = timeOnAirMs(31, MESH_PRESETS.LongFast); // plot ENI + en-tête
  assert.ok(plot > 400 && plot < 550, `${plot.toFixed(0)} ms`);
  assert.ok(Math.floor(36_000 / plot) < 100, 'moins de 100 plots par heure');
});

test('les positions à 120 s consomment près de la moitié du budget', () => {
  // Justifie MESH_POSITION_INTERVAL_MS, et montre que la marge restante pour
  // les ordres est mince : c'est au gouverneur d'arbitrer, pas à une constante.
  const perFrame = timeOnAirMs(44, MESH_PRESETS.LongFast); // Position protobuf + en-tête
  const perHour = (3_600 / 120) * perFrame;
  assert.ok(perHour / 36_000 > 0.4 && perHour / 36_000 < 0.55, `${(perHour / 360).toFixed(0)} %`);
});

test('la cadence du mode serveur serait illégale sur LoRa', () => {
  // POSITION_INTERVAL_MS vaut 30 s côté serveur : appliqué tel quel à la radio,
  // il dépasserait à lui seul le duty cycle autorisé.
  const perHour = (3_600 / 30) * timeOnAirMs(44, MESH_PRESETS.LongFast);
  assert.ok(perHour > 36_000, `${(perHour / 1000).toFixed(0)} s/h dépasse les 36 s autorisées`);
});

// --- budget ---

const T0 = 1_000_000;

test('autorise puis refuse au-delà de la fraction', () => {
  // 1 % d'une heure = 36 s.
  const b = new DutyCycleBudget(0.01);
  assert.equal(b.remainingMs(T0), 36_000);
  b.record(30_000, T0);
  assert.equal(b.canSend(5_000, T0), true);
  assert.equal(b.canSend(7_000, T0), false);
});

test('la fenêtre glisse au lieu de se réinitialiser', () => {
  // Une rafale en fin de fenêtre ne doit pas ouvrir droit à une seconde rafale
  // immédiate : c'est toute la différence avec un compteur horaire.
  const b = new DutyCycleBudget(0.01);
  b.record(36_000, T0);
  assert.equal(b.canSend(1, T0 + 3_599_000), false);
  assert.equal(b.canSend(1, T0 + 3_600_001), true);
});

test('libère le budget au fil de la fenêtre', () => {
  const b = new DutyCycleBudget(0.01);
  b.record(20_000, T0);
  b.record(16_000, T0 + 60_000);
  assert.equal(b.remainingMs(T0 + 120_000), 0);
  // La première émission sort de la fenêtre : seules les 16 s de la seconde
  // restent comptées, il redevient donc 20 s disponibles.
  assert.equal(b.remainingMs(T0 + 3_600_001), 20_000);
});

test('annonce quand une émission redeviendra possible', () => {
  const b = new DutyCycleBudget(0.01);
  b.record(36_000, T0);
  assert.equal(b.nextOpportunity(1_000, T0), T0 + 3_600_000);
  assert.equal(b.nextOpportunity(1_000, T0 + 3_600_001), T0 + 3_600_001);
});

test('signale l’impossible plutôt que de faire attendre indéfiniment', () => {
  // Une émission plus longue que le budget horaire entier ne passera jamais.
  const b = new DutyCycleBudget(0.01);
  assert.equal(b.nextOpportunity(40_000, T0), Number.POSITIVE_INFINITY);
});

test('la charge va de 0 à 1', () => {
  const b = new DutyCycleBudget(0.01);
  assert.equal(b.load(T0), 0);
  b.record(18_000, T0);
  assert.equal(b.load(T0), 0.5);
});

test('un poste tient la mission de référence dans son budget', () => {
  // Le duty cycle est par appareil : sur les 142 trames du scénario de
  // référence, un poste en émet une trentaine (16 positions + sa part
  // d'ordres) en 30 minutes.
  const b = new DutyCycleBudget(0.01);
  const p = MESH_PRESETS.LongFast;
  let t = T0;
  let sent = 0;
  for (let i = 0; i < 30; i++) {
    const toa = timeOnAirMs(45, p);
    if (b.canSend(toa, t)) {
      b.record(toa, t);
      sent++;
    }
    t += 60_000;
  }
  assert.equal(sent, 30, 'les 30 trames d’un poste doivent passer');
});

test('le chef, qui émet le plus, sature le premier', () => {
  // Celui qui pose les figurés cumule ses positions et tous les ordres : c'est
  // lui que le gouverneur devra freiner, et sur les envois les moins urgents.
  const b = new DutyCycleBudget(0.01);
  let refused = 0;
  for (let i = 0; i < 90; i++) {
    const toa = timeOnAirMs(45, MESH_PRESETS.LongFast);
    if (b.canSend(toa, T0)) b.record(toa, T0);
    else refused++;
  }
  assert.ok(refused > 0, 'une rafale de 90 trames doit finir par être refusée');
});
