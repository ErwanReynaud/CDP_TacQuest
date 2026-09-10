// Interface d'une radio Meshtastic, vue depuis TacQuest.
//
// Frontière stricte : au-dessus de cette interface, plus aucune notion de
// Meshtastic, de BLE ni de protobuf. En dessous, plus aucune notion d'ordre
// TacQuest, de salle ni de figuré. Le codec binaire fait la jonction, et rien
// d'autre ne traverse.
//
// C'est aussi ce qui rend la couche testable sans matériel : mockRadio.ts
// implémente la même interface et permet de simuler un mesh complet.

import type { Position } from '@tq/shared/protocol';

export type RadioStatus = 'disconnected' | 'connecting' | 'connected' | 'configuring';

/** Identité d'un nœud, telle qu'annoncée par NODEINFO_APP. */
export interface RadioUser {
  /** Indicatif (User.long_name). */
  callsign: string;
  /** Forme abrégée (User.short_name, 4 caractères). */
  shortName: string;
}

export interface RadioEvents {
  /** Trame reçue sur le portnum privé : charge utile de notre codec. */
  private: (payload: Uint8Array, from: number) => void;
  /** Position reçue d'un nœud (POSITION_APP). */
  position: (from: number, position: Position) => void;
  /** Identité reçue d'un nœud (NODEINFO_APP). */
  user: (from: number, user: RadioUser) => void;
  /** Message texte reçu (TEXT_MESSAGE_APP). */
  text: (from: number, body: string) => void;
  status: (status: RadioStatus) => void;
  /** Notre propre numéro de nœud, connu une fois la configuration terminée. */
  myNode: (nodeNum: number) => void;
  /** Erreur non fatale (trame indécodable, écriture refusée…). */
  error: (message: string) => void;
}

export interface Radio {
  /** Notre numéro de nœud, ou `null` tant que la configuration n'est pas finie. */
  readonly nodeNum: number | null;
  readonly status: RadioStatus;
  /** Émet une charge utile sur le portnum privé, en diffusion sur le canal. */
  sendPrivate(payload: Uint8Array): Promise<void>;
  /** Émet une position sur POSITION_APP. */
  sendPosition(position: Position): Promise<void>;
  /** Émet un message sur TEXT_MESSAGE_APP. */
  sendText(body: string): Promise<void>;
  /** Publie notre indicatif via NODEINFO_APP. */
  setOwner(user: RadioUser): Promise<void>;
  disconnect(): Promise<void>;
  /** Abonnement ; la fonction rendue se désabonne. */
  on<K extends keyof RadioEvents>(event: K, fn: RadioEvents[K]): () => void;
}

/**
 * Petit émetteur typé, partagé par les implémentations.
 *
 * Chaque écouteur est isolé : une exception dans l'un n'empêche pas les
 * suivants de tourner et ne remonte pas dans la pile de réception radio. Le bus
 * applicatif (state.ts) n'offre pas cette garantie — une trame malformée qui
 * ferait jeter un écouteur y coupe toute la chaîne.
 */
export class RadioEmitter {
  private readonly listeners = new Map<keyof RadioEvents, Set<(...a: never[]) => void>>();

  on<K extends keyof RadioEvents>(event: K, fn: RadioEvents[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as (...a: never[]) => void);
    return () => {
      set.delete(fn as (...a: never[]) => void);
    };
  }

  emit<K extends keyof RadioEvents>(event: K, ...args: Parameters<RadioEvents[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copie : un écouteur peut se désabonner (ou en abonner un autre) pendant
    // l'émission sans perturber l'itération en cours.
    for (const fn of [...set]) {
      try {
        (fn as (...a: unknown[]) => void)(...args);
      } catch (err) {
        // On ne réémet pas 'error' ici : un écouteur d'erreur qui jette
        // provoquerait une récursion infinie.
        console.error(`[radio] écouteur ${String(event)} en échec`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
