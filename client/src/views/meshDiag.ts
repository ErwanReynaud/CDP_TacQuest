// Mise en forme de l'état du lien radio pour le panneau de diagnostic.
//
// Fonction pure, sans DOM : sur le terrain c'est ce texte qu'on lit à voix
// haute ou qu'on copie dans un compte rendu, il doit donc se suffire à
// lui-même. Séparé du rendu pour rester testable.

import type { MeshStats } from '../transport/meshTransport';

const STATUS_FR: Record<string, string> = {
  disconnected: 'déconnecté',
  connecting: 'connexion…',
  configuring: 'configuration…',
  connected: 'connecté',
};

function pad(label: string, width = 16): string {
  return label.padEnd(width);
}

/** « 1 234 o » ou « 12,3 ko » — lisible d'un coup d'œil sur un écran de terrain. */
function bytes(n: number): string {
  return n < 10_000 ? `${n} o` : `${(n / 1000).toFixed(1)} ko`;
}

/**
 * Rend l'état du lien en texte fixe.
 *
 * Ce que ce bloc doit permettre de trancher, dans l'ordre où la question se
 * pose sur le terrain : le module est-il connecté ? entend-on quelqu'un ?
 * comprend-on ce qu'on entend ? et reste-t-il des ordres à rattraper ?
 */
export function formatMeshStats(stats: MeshStats | null): string {
  if (!stats) {
    return 'Aucun module radio connecté.\nLe mode radio est inactif — seuls le serveur et la carte solo fonctionnent.';
  }

  const lines: string[] = [];
  lines.push(`${pad('État')}${STATUS_FR[stats.status] ?? stats.status}`);
  lines.push(
    `${pad('Nœud')}${stats.nodeNum !== null ? stats.nodeNum.toString(16).padStart(8, '0') : '—'}`,
  );
  lines.push(
    `${pad('Ancre de zone')}${
      stats.anchor ? `${stats.anchor.lat.toFixed(2)}, ${stats.anchor.lng.toFixed(2)}` : 'non établie'
    }`,
  );

  lines.push('');
  lines.push(`${pad('Reçu')}${stats.rx.frames} trames · ${bytes(stats.rx.bytes)}`);
  lines.push(`${pad('  dont ordres')}${stats.rx.orders}`);
  lines.push(`${pad('  positions')}${stats.rx.positions}`);
  lines.push(`${pad('  illisibles')}${stats.rx.errors}`);

  const k = stats.tx.byKind;
  lines.push('');
  lines.push(`${pad('Émis')}${stats.tx.frames} trames · ${bytes(stats.tx.bytes)}`);
  lines.push(`${pad('  ordres')}${k.order}`);
  lines.push(`${pad('  relais')}${k.relay}`);
  lines.push(`${pad('  positions')}${k.position}`);
  lines.push(`${pad('  digests')}${k.digest}`);
  lines.push(`${pad('  demandes')}${k.req}`);

  const a = stats.airtime;
  lines.push('');
  lines.push(`${pad('Airtime')}${(a.load * 100).toFixed(0)} % du budget horaire`);
  lines.push(`${pad('  consommé')}${(a.usedMs / 1000).toFixed(1)} s`);
  lines.push(`${pad('  disponible')}${(a.remainingMs / 1000).toFixed(1)} s`);
  lines.push(`${pad('  en attente')}${a.queued}`);
  if (a.dropped > 0) lines.push(`${pad('  abandonnées')}${a.dropped}`);

  lines.push('');
  lines.push(`${pad('Auteurs connus')}${stats.sync.authors}`);
  lines.push(`${pad('Trous')}${stats.sync.gaps}`);
  lines.push(`${pad('À réémettre')}${stats.sync.scheduled}`);
  lines.push(`${pad('À réclamer')}${stats.sync.requests}`);

  // Une interprétation explicite : sur le terrain, personne n'a le temps de
  // déduire « 0 trou et 0 réémission » d'une colonne de chiffres.
  lines.push('');
  lines.push(diagnosis(stats));

  if (stats.lastError) {
    lines.push('');
    lines.push(`Dernière trame rejetée ${stats.lastError}`);
  }
  return lines.join('\n');
}

/** Résume la situation en une phrase actionnable. */
function diagnosis(s: MeshStats): string {
  if (s.status !== 'connected') return '→ Module non connecté.';
  if (s.rx.frames === 0) {
    return '→ Aucune trame reçue : personne à portée, ou canal et clé différents.';
  }
  if (s.rx.errors > 0 && s.rx.orders === 0) {
    // Cas piégeux : la radio fonctionne, c'est l'application qui ne suit pas.
    return '→ Des trames arrivent mais aucune n’est décodable : vérifiez que tous les postes ont la même version de TacQuest.';
  }
  if (!s.anchor) return '→ En attente d’un premier point GPS pour établir l’ancre de zone.';
  if (s.airtime.load > 0.9) {
    // Le duty cycle est légal, pas indicatif : le module refusera d'émettre.
    return '→ Budget radio presque épuisé : les envois sont mis en file et les positions espacées.';
  }
  if (s.sync.gaps > 0 || s.sync.requests > 0) {
    return `→ Rattrapage en cours : ${s.sync.gaps} trou(s) à combler.`;
  }
  return '→ Lien nominal, carte à jour.';
}
