// Page d'installation : sur mobile dans un navigateur (pas en PWA installée),
// on masque le site et on explique comment ajouter l'app à l'écran d'accueil.
// Un petit bouton permet de continuer quand même dans le navigateur.
//
// C'est aussi le premier des deux points où l'indisponibilité du mode radio est
// annoncée — l'autre étant la tentative de connexion elle-même. Les deux tirent
// leur diagnostic de mesh/platform.ts, pour ne jamais se contredire : rien de
// pire que d'installer l'app sur la foi d'un message, puis de découvrir sur le
// terrain que la radio ne se connecte pas.

import { bleSupport, detectPlatform, isStandalone, type Platform } from '../mesh/platform';

const DISMISS_KEY = 'tq-install-dismissed';

// Doit-on afficher la page d'installation ? Mobile + navigateur + pas déjà ignorée.
export function shouldShowInstallGate(): boolean {
  if (isStandalone()) return false;
  // Sur poste fixe, l'installation est facultative et l'app est pleinement
  // utilisable dans un onglet : on n'impose pas d'écran intermédiaire. Un
  // navigateur de bureau incapable de Bluetooth est signalé dans le tiroir et
  // à la connexion, pas ici.
  if (detectPlatform() === 'desktop') return false;
  try {
    if (localStorage.getItem(DISMISS_KEY) === '1') return false;
  } catch {
    /* localStorage indisponible : on affiche quand même la page. */
  }
  return true;
}

/** Avertissement sur le mode radio, affiché seulement s'il est indisponible. */
function radioWarning(): string {
  const support = bleSupport();
  if (support.supported) return '';
  return `<p class="install-warning">⚠️ ${escapeText(support.message)}</p>`;
}

/** Les messages viennent de nos constantes, mais l'échappement reste la règle. */
function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function instructions(platform: Platform): string {
  if (platform === 'ios') {
    return `
      <ol class="install-steps">
        <li>Ouvrez cette page dans <b>Safari</b> (l'installation ne marche pas
            depuis une autre app).</li>
        <li>Touchez l'icône <b>Partager</b>
            <span class="install-glyph">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8"/></svg>
            </span>
            en bas de l'écran.</li>
        <li>Choisissez <b>« Sur l'écran d'accueil »</b>.</li>
        <li>Lancez TacticalQuest depuis l'icône ajoutée.</li>
      </ol>`;
  }
  return `
      <ol class="install-steps">
        <li>Ouvrez cette page dans <b>Chrome</b>.</li>
        <li>Touchez le menu <b>⋮</b> en haut à droite.</li>
        <li>Choisissez <b>« Installer l'application »</b>
            (ou <b>« Ajouter à l'écran d'accueil »</b>).</li>
        <li>Lancez TacticalQuest depuis l'icône ajoutée.</li>
      </ol>`;
}

// Construit et affiche la page. Renvoie une fonction de fermeture (continuer
// dans le navigateur), qui mémorise le choix pour ne plus réafficher la page.
export function showInstallGate(onContinue: () => void): void {
  const platform = detectPlatform();

  const gate = document.createElement('div');
  gate.id = 'install-gate';
  gate.innerHTML = `
    <div class="install-card">
      <img class="install-logo" src="/icons/icon-192.png" alt="" width="72" height="72" />
      <h1>TacticalQuest</h1>
      <p class="install-lead">Pour une carte plein écran, hors-ligne et plus
         fiable sur le terrain, installez l'application sur votre téléphone.</p>
      ${radioWarning()}
      ${instructions(platform)}
      <button id="install-continue" class="install-skip">Continuer dans le navigateur</button>
    </div>`;
  document.body.appendChild(gate);
  document.body.classList.add('install-locked');

  gate.querySelector<HTMLButtonElement>('#install-continue')!.addEventListener('click', () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    gate.remove();
    document.body.classList.remove('install-locked');
    onContinue();
  });
}
