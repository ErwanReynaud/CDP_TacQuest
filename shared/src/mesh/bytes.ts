// Curseurs de lecture/écriture et varints zigzag.
//
// Pas de dépendance : le même code tourne dans le navigateur (transport BLE) et
// sous Node (tests, pont serveur).

import { MESH_MAX_PAYLOAD } from './constants.ts';

/** Dépassement du budget de trame, ou trame tronquée/corrompue. */
export class MeshCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeshCodecError';
  }
}

export class Writer {
  private buf: Uint8Array;
  private pos = 0;

  constructor(capacity = MESH_MAX_PAYLOAD) {
    this.buf = new Uint8Array(capacity);
  }

  get length(): number {
    return this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new MeshCodecError(
        `trame trop longue : ${this.pos + n} o > budget ${this.buf.length} o`,
      );
    }
  }

  u8(v: number): this {
    this.need(1);
    this.buf[this.pos++] = v & 0xff;
    return this;
  }

  /** Entier 16 bits non signé, petit-boutiste (convention Meshtastic/protobuf). */
  u16(v: number): this {
    this.need(2);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    return this;
  }

  i16(v: number): this {
    if (v < -32768 || v > 32767) throw new MeshCodecError(`i16 hors bornes : ${v}`);
    return this.u16(v < 0 ? v + 0x10000 : v);
  }

  u32(v: number): this {
    this.need(4);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    this.buf[this.pos++] = (v >>> 16) & 0xff;
    this.buf[this.pos++] = (v >>> 24) & 0xff;
    return this;
  }

  i32(v: number): this {
    return this.u32(v < 0 ? v + 0x1_0000_0000 : v);
  }

  /** Varint LEB128 non signé (1 o jusqu'à 127, 2 o jusqu'à 16 383…). */
  varint(v: number): this {
    if (v < 0 || !Number.isInteger(v)) throw new MeshCodecError(`varint invalide : ${v}`);
    let x = v;
    while (x >= 0x80) {
      this.u8((x & 0x7f) | 0x80);
      x = Math.floor(x / 128);
    }
    return this.u8(x);
  }

  /** Varint zigzag : les petits deltas négatifs coûtent aussi 1 o. */
  zigzag(v: number): this {
    if (!Number.isInteger(v)) throw new MeshCodecError(`zigzag invalide : ${v}`);
    return this.varint(v < 0 ? -2 * v - 1 : 2 * v);
  }

  /**
   * Chaîne UTF-8 préfixée d'une longueur sur 1 o. Tronquée sur une frontière de
   * caractère si elle dépasse `max` : sur le terrain, un nom amputé vaut mieux
   * qu'un ordre rejeté.
   */
  str(s: string, max = 255): this {
    let bytes = new TextEncoder().encode(s);
    if (bytes.length > max) {
      // Remonter au début du dernier caractère entamé, et ne le retirer que
      // s'il est réellement incomplet : couper pile sur une frontière ne doit
      // pas sacrifier un caractère qui tenait.
      let end = max;
      let i = end - 1;
      while (i >= 0 && (bytes[i]! & 0xc0) === 0x80) i--;
      if (i >= 0) {
        const lead = bytes[i]!;
        const len = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (i + len > end) end = i;
      }
      bytes = bytes.subarray(0, end);
    }
    this.u8(bytes.length);
    this.need(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
    return this;
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class Reader {
  private pos = 0;
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw new MeshCodecError('trame tronquée');
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  u16(): number {
    this.need(2);
    return this.buf[this.pos++]! | (this.buf[this.pos++]! << 8);
  }

  i16(): number {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }

  u32(): number {
    this.need(4);
    return (
      (this.buf[this.pos++]! |
        (this.buf[this.pos++]! << 8) |
        (this.buf[this.pos++]! << 16) |
        (this.buf[this.pos++]! << 24)) >>>
      0
    );
  }

  i32(): number {
    const v = this.u32();
    return v >= 0x8000_0000 ? v - 0x1_0000_0000 : v;
  }

  varint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return result;
      shift *= 128;
    }
    throw new MeshCodecError('varint trop long');
  }

  zigzag(): number {
    const v = this.varint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  str(): string {
    const len = this.u8();
    this.need(len);
    const s = new TextDecoder().decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
}
