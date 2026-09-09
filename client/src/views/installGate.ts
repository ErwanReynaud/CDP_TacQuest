// Page d'installation : sur mobile dans un navigateur (pas en PWA installée),
// on masque le site et on explique comment ajouter l'app à l'écran d'accueil.
// Un petit bouton permet de continuer quand même dans le navigateur.

const DISMISS_KEY = 'tq-install-dismissed';

type Platform = 'ios' | 'android';

function detectPlatform(): Platform | null {
  const ua = navigator.userAgent;
  // iPadOS 13+ se déguise en macOS : on le repère au tactile.
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return null;
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari : drapeau non standard.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

// Doit-on afficher la page d'installation ? Mobile + navigateur + pas déjà ignorée.
export function shouldShowInstallGate(): boolean {
  if (isStandalone()) return false;
  if (detectPlatform() === null) return false;
  try {
    if (localStorage.getItem(DISMISS_KEY) === '1') return false;
  } catch {
    /* localStorage indisponible : on affiche quand même la page. */
  }
  return true;
}

function instructions(platform: Platform): string {
  if (platform === 'ios') {
    return `
      <p class="install-warning">⚠️ Sur iPhone/iPad, la connexion au module
         Meshtastic (Bluetooth) n'est pas disponible — limitation d'Apple/Safari,
         même une fois l'app installée. Le suivi de position et les cartes
         fonctionneront normalement.</p>
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
  const platform = detectPlatform() ?? 'android';

  const gate = document.createElement('div');
  gate.id = 'install-gate';
  gate.innerHTML = `
    <div class="install-card">
      <img class="install-logo" src="/icons/icon-192.png" alt="" width="72" height="72" />
      <h1>TacticalQuest</h1>
      <p class="install-lead">Pour une carte plein écran, hors-ligne et plus
         fiable sur le terrain, installez l'application sur votre téléphone.</p>
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
