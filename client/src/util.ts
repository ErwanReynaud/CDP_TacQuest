export function uid(): string {
  // crypto.randomUUID absent des vieux WebView (pré-Chrome 92) : fallback.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Couleur CSS inoffensive : hex (#rgb…#rrggbbaa) ou nom purement alphabétique.
// Volontairement strict — les ordres relayés par le serveur ne sont PAS de
// confiance, et `color` est injecté dans des attributs `style="…"`. Ce filtre
// interdit guillemets, < > (évasion d'attribut) et ; ( ) : (injection CSS/url()).
const SAFE_COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^[a-zA-Z]{1,20}$/;

/** Renvoie la couleur si elle est sûre, sinon null (au caller de défausser). */
export function safeColor(c: unknown): string | null {
  return typeof c === 'string' && SAFE_COLOR_RE.test(c) ? c : null;
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}
