// Journal de diagnostic en mémoire — pour déboguer ce qui n'est pas observable
// (écran verrouillé, pas de console). On horodate chaque événement ; l'écart
// avec l'entrée précédente (+Xs) révèle les trous (JS gelé, GPS muet…).

export interface LogEntry {
  t: number;
  tag: string;
  msg: string;
}

const MAX = 300;
const buf: LogEntry[] = [];
const subs = new Set<() => void>();

export function dlog(tag: string, msg = ''): void {
  buf.push({ t: Date.now(), tag, msg });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  for (const s of subs) s();
}

export function getLog(): readonly LogEntry[] {
  return buf;
}

export function clearLog(): void {
  buf.length = 0;
  for (const s of subs) s();
}

export function onLog(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

function hms(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Rendu texte avec l'écart depuis l'entrée précédente (repère les trous). */
export function formatLog(): string {
  const lines: string[] = [];
  let prev = 0;
  for (const e of buf) {
    const gap = prev ? `+${Math.round((e.t - prev) / 1000)}s` : '';
    lines.push(`${hms(e.t)} ${gap.padStart(6)} ${e.tag.padEnd(5)} ${e.msg}`);
    prev = e.t;
  }
  return lines.join('\n');
}
