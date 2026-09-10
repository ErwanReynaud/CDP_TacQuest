// Radio simulée : un mesh LoRa complet, en mémoire, sans matériel.
//
// Implémente la même interface `Radio` que bleRadio.ts. Un `MockMesh` relie
// plusieurs radios entre elles et reproduit ce qui casse réellement sur le
// terrain : perte de paquets, partition du réseau, budget de charge utile.
//
// Utilisé par les tests, et exploitable en développement pour travailler sur la
// synchronisation sans sortir deux modules du placard.

import type { Position } from '@tq/shared/protocol';
import { MESH_MAX_PAYLOAD } from '@tq/shared/mesh/constants';
import { type Radio, RadioEmitter, type RadioEvents, type RadioStatus, type RadioUser } from './radio';

/** Paquet en transit dans le mesh simulé. */
interface MockPacket {
  from: number;
  kind: 'private' | 'position' | 'text' | 'user';
  payload: Uint8Array | Position | string | RadioUser;
}

export interface MockMeshOptions {
  /** Probabilité de perte d'un paquet, 0 à 1. Par défaut 0 (canal parfait). */
  lossRate?: number;
  /** Générateur aléatoire injectable, pour des tests déterministes. */
  random?: () => number;
}

/**
 * Réseau simulé. Les radios qui y sont attachées se voient mutuellement, sauf
 * si elles sont placées dans des partitions différentes.
 */
export class MockMesh {
  private readonly radios = new Set<MockRadio>();
  /** Partition de chaque nœud : deux nœuds ne s'entendent que dans la même. */
  private readonly partitions = new Map<number, string>();
  private readonly lossRate: number;
  private readonly random: () => number;
  /** Journal de tout ce qui a été émis, pour les assertions de budget. */
  readonly sent: { from: number; kind: string; bytes: number }[] = [];

  constructor(opts: MockMeshOptions = {}) {
    this.lossRate = opts.lossRate ?? 0;
    this.random = opts.random ?? Math.random;
  }

  /** Crée une radio attachée à ce mesh. */
  radio(nodeNum: number): MockRadio {
    const r = new MockRadio(nodeNum, this);
    this.radios.add(r);
    this.partitions.set(nodeNum, 'default');
    return r;
  }

  /**
   * Place des nœuds dans une partition nommée. Deux nœuds de partitions
   * différentes ne s'entendent plus — c'est le scénario « groupe hors portée
   * plusieurs heures » que le CRDT doit encaisser.
   */
  partition(name: string, nodeNums: number[]): void {
    for (const n of nodeNums) this.partitions.set(n, name);
  }

  /** Remet tout le monde à portée. */
  heal(): void {
    for (const key of this.partitions.keys()) this.partitions.set(key, 'default');
  }

  private reaches(from: number, to: number): boolean {
    return this.partitions.get(from) === this.partitions.get(to);
  }

  /** Diffuse un paquet à toutes les radios joignables sauf l'émettrice. */
  broadcast(pkt: MockPacket): void {
    const bytes = pkt.payload instanceof Uint8Array ? pkt.payload.length : 0;
    if (bytes > MESH_MAX_PAYLOAD) {
      throw new Error(`trame de ${bytes} o : au-delà du budget ${MESH_MAX_PAYLOAD} o`);
    }
    this.sent.push({ from: pkt.from, kind: pkt.kind, bytes });
    for (const r of this.radios) {
      if (r.nodeNum === pkt.from) continue;
      if (!this.reaches(pkt.from, r.nodeNum)) continue;
      if (this.lossRate > 0 && this.random() < this.lossRate) continue;
      r.receive(pkt);
    }
  }

  /** Total d'octets émis, pour vérifier qu'un scénario tient le budget radio. */
  totalBytes(): number {
    return this.sent.reduce((n, s) => n + s.bytes, 0);
  }
}

export class MockRadio implements Radio {
  private readonly emitter = new RadioEmitter();
  private readonly mesh: MockMesh;
  private readonly node: number;
  private currentStatus: RadioStatus = 'connected';
  /** Indicatif publié, pour vérifier que setOwner a bien été appelé. */
  owner: RadioUser | null = null;

  constructor(nodeNum: number, mesh: MockMesh) {
    this.node = nodeNum;
    this.mesh = mesh;
  }

  get nodeNum(): number {
    return this.node;
  }

  get status(): RadioStatus {
    return this.currentStatus;
  }

  /** Appelé par le mesh : distribue un paquet entrant aux écouteurs. */
  receive(pkt: MockPacket): void {
    switch (pkt.kind) {
      case 'private':
        this.emitter.emit('private', pkt.payload as Uint8Array, pkt.from);
        break;
      case 'position':
        this.emitter.emit('position', pkt.from, pkt.payload as Position);
        break;
      case 'text':
        this.emitter.emit('text', pkt.from, pkt.payload as string);
        break;
      case 'user':
        this.emitter.emit('user', pkt.from, pkt.payload as RadioUser);
        break;
    }
  }

  sendPrivate(payload: Uint8Array): Promise<void> {
    this.mesh.broadcast({ from: this.node, kind: 'private', payload });
    return Promise.resolve();
  }

  sendPosition(position: Position): Promise<void> {
    this.mesh.broadcast({ from: this.node, kind: 'position', payload: position });
    return Promise.resolve();
  }

  sendText(body: string): Promise<void> {
    this.mesh.broadcast({ from: this.node, kind: 'text', payload: body });
    return Promise.resolve();
  }

  setOwner(user: RadioUser): Promise<void> {
    this.owner = user;
    this.mesh.broadcast({ from: this.node, kind: 'user', payload: user });
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.currentStatus = 'disconnected';
    this.emitter.emit('status', 'disconnected');
    return Promise.resolve();
  }

  on<K extends keyof RadioEvents>(event: K, fn: RadioEvents[K]): () => void {
    return this.emitter.on(event, fn);
  }
}
