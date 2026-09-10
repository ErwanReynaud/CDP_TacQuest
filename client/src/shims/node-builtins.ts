// Équivalents navigateur des modules Node importés par @meshtastic/core.
//
// Le bundle de @meshtastic/core embarque tslog, dont le chemin Node importe
// statiquement `os`, `path` et `util`. Rollup refuse alors de construire pour
// le navigateur : « "hostname" is not exported by __vite-browser-external ».
//
// tslog choisit son runtime navigateur à l'exécution, ces fonctions ne
// devraient donc jamais être appelées. On leur donne quand même un
// comportement correct plutôt que de lever : un journal qui se dégrade vaut
// mieux qu'une application qui s'arrête, et le mode radio est précisément ce
// qu'on voudra diagnostiquer sur le terrain.
//
// vite.config.ts fait pointer `os`, `path` et `util` vers ce fichier. Un import
// ESM n'exige que la présence des noms importés : les trois modules peuvent
// donc partager une seule implémentation.

/** `os.hostname()` — l'hôte servant l'application fait un repère utile. */
export function hostname(): string {
  return typeof location !== 'undefined' ? location.hostname : 'navigateur';
}

/** `path.normalize()` — suffisant pour l'étiquette de fichier d'une ligne de log. */
export function normalize(p: string): string {
  const segments: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return (p.startsWith('/') ? '/' : '') + segments.join('/');
}

/** `util.types` — seul `isNativeError` est utilisé par tslog. */
export const types = {
  isNativeError(v: unknown): v is Error {
    return v instanceof Error;
  },
};

/** `util.formatWithOptions()` — mise en forme approchante, sans les codes ANSI. */
export function formatWithOptions(_options: unknown, ...args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        // Références circulaires : ne jamais faire échouer une écriture de log.
        return String(a);
      }
    })
    .join(' ');
}

export function format(...args: unknown[]): string {
  return formatWithOptions(undefined, ...args);
}

export function inspect(v: unknown): string {
  return formatWithOptions(undefined, v);
}

export default { hostname, normalize, types, formatWithOptions, format, inspect };
