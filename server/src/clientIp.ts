/**
 * Résolution de l'IP réelle du client, dérrière un proxy (Fly, Caddy) comme en
 * direct. Générique : fonctionne pour une requête Express comme pour un
 * handshake Socket.IO — il suffit de fournir un accès aux en-têtes.
 *
 * Priorité à `Fly-Client-IP` : posé par l'edge Fly et **non usurpable**,
 * contrairement à `X-Forwarded-For` que n'importe quel client peut forger. Le
 * XFF n'est retenu qu'en repli (autres proxys), et le `fallback` (adresse de
 * socket) en dernier ressort. Sans cette résolution, tout ce qui vit derrière
 * le proxy verrait la même IP interne — rate-limiting et verrous anti
 * brute-force deviendraient inopérants (create/join) ou globaux.
 */
export type HeaderLookup = (name: string) => string | undefined;

export function resolveClientIp(get: HeaderLookup, fallback = 'unknown'): string {
  const fly = get('fly-client-ip');
  if (fly) return fly.trim();
  const xff = (get('x-forwarded-for') ?? '').split(',')[0]!.trim();
  if (xff) return xff;
  return fallback;
}

/** Accès aux en-têtes d'un handshake Socket.IO (valeurs string | string[]). */
export function headerLookupFrom(headers: Record<string, string | string[] | undefined>): HeaderLookup {
  return (name) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
}
