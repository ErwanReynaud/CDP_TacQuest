import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RoomManager } from './rooms';

export interface Persistence {
  /** Recharge l'état depuis le snapshot disque (à appeler avant listen). */
  load(): Promise<void>;
  /** Écrit immédiatement un snapshot (écriture atomique). */
  save(): Promise<void>;
  /** Démarre la sauvegarde périodique. */
  start(): void;
  /** Arrête la sauvegarde périodique. */
  stop(): void;
}

/**
 * Persistance de l'état serveur sur disque (volume Fly monté sur DATA_DIR).
 * Snapshot JSON sauvegardé périodiquement + à l'arrêt, rechargé au démarrage :
 * l'état survit aux redémarrages, redéploiements et crashs. La fenêtre de perte
 * est bornée par `intervalMs` (quelques secondes), acceptable pour des rooms
 * éphémères dont les positions sont de toute façon rafraîchies en continu.
 */
export function createPersistence(
  manager: RoomManager,
  filePath: string,
  intervalMs: number,
): Persistence {
  let timer: NodeJS.Timeout | null = null;
  // Chaîne les sauvegardes : jamais deux écritures concurrentes sur le fichier.
  let pending: Promise<void> = Promise.resolve();

  async function load(): Promise<void> {
    try {
      const raw = await readFile(filePath, 'utf8');
      manager.restore(JSON.parse(raw));
      console.log(`État rechargé depuis ${filePath}.`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.log(`Aucun snapshot (${filePath}) : démarrage à vide.`);
      } else {
        // Snapshot corrompu/illisible : on n'efface rien, on démarre à vide.
        console.error('Snapshot illisible, démarrage à vide :', err);
      }
    }
  }

  async function writeSnapshot(): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    // Écriture atomique : écrire le tmp puis renommer, pour ne jamais laisser
    // un snapshot à moitié écrit si le process meurt en plein vol.
    await writeFile(tmp, JSON.stringify(manager.snapshot()));
    await rename(tmp, filePath);
  }

  function save(): Promise<void> {
    pending = pending
      .catch(() => {})
      .then(writeSnapshot)
      .catch((err) => console.error('Échec sauvegarde snapshot :', err));
    return pending;
  }

  return {
    load,
    save,
    start() {
      if (timer) return;
      timer = setInterval(() => void save(), intervalMs);
      // Ne pas maintenir le process en vie juste pour ce timer.
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
