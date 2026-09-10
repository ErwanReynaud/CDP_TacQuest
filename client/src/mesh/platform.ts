// Détection de plateforme et de disponibilité du Bluetooth Web.
//
// Source unique pour la page d'installation (views/installGate.ts) et pour la
// connexion au module (mesh/bleRadio.ts) : les deux doivent dire exactement la
// même chose, sinon l'utilisateur installe l'app puis découvre sur le terrain
// que la radio ne se connecte pas.

export type Platform = 'ios' | 'android' | 'desktop';

/** Cause précise d'indisponibilité du Bluetooth Web. */
export type BleBlockReason =
  /** iOS/iPadOS : Apple n'expose pas Web Bluetooth, même en PWA installée. */
  | 'ios'
  /** Safari de bureau : n'implémente pas la spécification. */
  | 'safari'
  /** Firefox : implémentation désactivée par défaut, sans intention de l'activer. */
  | 'firefox'
  /** Origine non sécurisée : l'API n'existe pas hors HTTPS (ou localhost). */
  | 'insecure-context'
  /** Navigateur sans l'API, cause non identifiée. */
  | 'unsupported';

export interface BleSupport {
  supported: boolean;
  reason?: BleBlockReason;
  /** Message prêt à afficher, en français, expliquant la cause et le recours. */
  message: string;
}

interface Nav {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  bluetooth?: unknown;
  standalone?: boolean;
}

function nav(): Nav {
  return navigator as unknown as Nav;
}

/**
 * iOS ou iPadOS. iPadOS 13+ se déclare « MacIntel » : on le démasque au
 * tactile, un Mac n'ayant pas d'écran tactile.
 */
export function isIOS(): boolean {
  const n = nav();
  return (
    /iPad|iPhone|iPod/.test(n.userAgent) ||
    (n.platform === 'MacIntel' && (n.maxTouchPoints ?? 0) > 1)
  );
}

/** Safari, y compris de bureau. Chrome et Edge se déclarent aussi « Safari ». */
export function isSafari(): boolean {
  const ua = nav().userAgent;
  return /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua);
}

export function isFirefox(): boolean {
  return /Firefox|FxiOS/.test(nav().userAgent);
}

export function detectPlatform(): Platform {
  if (isIOS()) return 'ios';
  return /Android/.test(nav().userAgent) ? 'android' : 'desktop';
}

/** L'app tourne-t-elle en PWA installée (et non dans un onglet) ? */
export function isStandalone(): boolean {
  // `standalone` seul ne suffit pas : un manifest en `fullscreen` ou
  // `minimal-ui` ne déclenche pas ce media query. On teste donc l'inverse —
  // « pas dans un navigateur » — ce qui couvre les trois modes autonomes.
  const browser = window.matchMedia('(display-mode: browser)');
  if (browser.media === '(display-mode: browser)' && !browser.matches) return true;
  // iOS Safari : drapeau non standard, seul indice disponible.
  return nav().standalone === true;
}

/**
 * Le Bluetooth Web est-il utilisable ici, et sinon pourquoi ?
 *
 * L'ordre des tests importe. iOS d'abord : c'est la cause racine et elle est
 * définitive. Le contexte sécurisé ensuite, **avant** de regarder
 * `navigator.bluetooth` — hors HTTPS l'API est absente, et conclure « navigateur
 * non supporté » enverrait l'utilisateur changer de navigateur alors qu'il faut
 * changer d'URL. C'est un cas réaliste : un serveur de campagne servi en HTTP
 * sur le réseau local.
 */
export function bleSupport(): BleSupport {
  if (isIOS()) {
    return {
      supported: false,
      reason: 'ios',
      message:
        'iPhone et iPad ne permettent pas de se connecter en Bluetooth à un module ' +
        'Meshtastic : Apple n’implémente pas le Bluetooth Web, y compris une fois ' +
        'l’application installée. Utilisez un appareil Android ou un PC sous Chrome ' +
        'ou Edge pour le mode radio.',
    };
  }
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: 'insecure-context',
      message:
        'Le Bluetooth Web exige une connexion sécurisée. Ouvrez l’application en ' +
        'HTTPS (ou depuis localhost) : en HTTP simple, le navigateur masque l’API, ' +
        'même s’il la prend en charge.',
    };
  }
  if (nav().bluetooth == null) {
    if (isFirefox()) {
      return {
        supported: false,
        reason: 'firefox',
        message:
          'Firefox n’active pas le Bluetooth Web. Utilisez Chrome ou Edge pour vous ' +
          'connecter au module Meshtastic.',
      };
    }
    if (isSafari()) {
      return {
        supported: false,
        reason: 'safari',
        message:
          'Safari n’implémente pas le Bluetooth Web. Utilisez Chrome ou Edge pour ' +
          'vous connecter au module Meshtastic.',
      };
    }
    return {
      supported: false,
      reason: 'unsupported',
      message:
        'Ce navigateur ne prend pas en charge le Bluetooth Web. Chrome ou Edge, sur ' +
        'Android ou sur PC, sont nécessaires pour le mode radio.',
    };
  }
  return { supported: true, message: 'Bluetooth Web disponible.' };
}
