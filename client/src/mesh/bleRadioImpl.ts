// Implémentation Meshtastic du transport BLE.
//
// Séparé de bleRadio.ts et chargé dynamiquement : @meshtastic/core et son
// runtime protobuf pèsent près d'un mégaoctet, que seuls les utilisateurs
// appairant réellement un module ont à télécharger. Sur un lien de campagne,
// c'est la différence entre une PWA qui s'installe et une qui n'arrive pas.
//
// Le GATT (service, caractéristiques toRadio/fromRadio/fromNum, reconnexion)
// est pris en charge par @meshtastic/transport-web-bluetooth ; ce module câble
// ce transport sur MeshDevice et traduit les événements Meshtastic vers
// l'interface Radio, sans jamais laisser fuir de type Meshtastic au-dessus.

import { create } from '@bufbuild/protobuf';
import { MeshDevice, Protobuf, Types } from '@meshtastic/core';
import { TransportWebBluetooth } from '@meshtastic/transport-web-bluetooth';
import type { Position } from '@tq/shared/protocol';
import { encodePosition, fromMeshPosition } from './positionCodec';
import { BleUnavailableError, type BleRadioOptions } from './bleRadio';
import { type Radio, RadioEmitter, type RadioEvents, type RadioStatus, type RadioUser } from './radio';

const STATUS: Record<number, RadioStatus> = {
  [Types.DeviceStatusEnum.DeviceDisconnected]: 'disconnected',
  [Types.DeviceStatusEnum.DeviceConnecting]: 'connecting',
  [Types.DeviceStatusEnum.DeviceReconnecting]: 'connecting',
  [Types.DeviceStatusEnum.DeviceConnected]: 'connected',
  [Types.DeviceStatusEnum.DeviceConfiguring]: 'configuring',
  [Types.DeviceStatusEnum.DeviceConfigured]: 'connected',
  [Types.DeviceStatusEnum.DeviceRestarting]: 'connecting',
};

class BleRadio implements Radio {
  private readonly emitter = new RadioEmitter();
  private readonly device: MeshDevice;
  private readonly channel: Types.ChannelNumber;
  private myNodeNum: number | null = null;
  private currentStatus: RadioStatus = 'connecting';

  constructor(device: MeshDevice, channel: Types.ChannelNumber) {
    this.device = device;
    this.channel = channel;
    this.wire();
  }

  get nodeNum(): number | null {
    return this.myNodeNum;
  }

  get status(): RadioStatus {
    return this.currentStatus;
  }

  private wire(): void {
    const ev = this.device.events;

    ev.onDeviceStatus.subscribe((s) => {
      this.currentStatus = STATUS[s] ?? 'disconnected';
      this.emitter.emit('status', this.currentStatus);
    });

    ev.onMyNodeInfo.subscribe((info) => {
      this.myNodeNum = info.myNodeNum;
      this.emitter.emit('myNode', info.myNodeNum);
    });

    ev.onPrivatePacket.subscribe((p) => {
      // Nos propres trames nous reviennent par le module : le CRDT est
      // idempotent, mais les filtrer ici économise un décodage inutile.
      if (p.from === this.myNodeNum) return;
      this.emitter.emit('private', p.data, p.from);
    });

    ev.onPositionPacket.subscribe((p) => {
      if (p.from === this.myNodeNum) return;
      try {
        const pos = fromMeshPosition(p.data, p.rxTime);
        if (pos) this.emitter.emit('position', p.from, pos);
      } catch (err) {
        this.emitter.emit('error', `position illisible de ${p.from} : ${String(err)}`);
      }
    });

    ev.onUserPacket.subscribe((p) => {
      if (p.from === this.myNodeNum) return;
      this.emitter.emit('user', p.from, {
        callsign: p.data.longName,
        shortName: p.data.shortName,
      });
    });

    ev.onMessagePacket.subscribe((p) => {
      if (p.from === this.myNodeNum) return;
      this.emitter.emit('text', p.from, p.data);
    });
  }

  async sendPrivate(payload: Uint8Array): Promise<void> {
    await this.device.sendPacket(
      payload,
      Protobuf.Portnums.PortNum.PRIVATE_APP,
      'broadcast',
      this.channel,
    );
  }

  async sendPosition(position: Position): Promise<void> {
    await this.device.sendPacket(
      encodePosition(position),
      Protobuf.Portnums.PortNum.POSITION_APP,
      'broadcast',
      this.channel,
    );
  }

  async sendText(body: string): Promise<void> {
    await this.device.sendText(body, 'broadcast', false, this.channel);
  }

  async setOwner(user: RadioUser): Promise<void> {
    await this.device.setOwner(
      create(Protobuf.Mesh.UserSchema, {
        longName: user.callsign,
        // `short_name` est plafonné à 4 caractères côté firmware.
        shortName: user.shortName.slice(0, 4),
      }),
    );
  }

  async disconnect(): Promise<void> {
    await this.device.disconnect();
    this.currentStatus = 'disconnected';
    this.emitter.emit('status', 'disconnected');
    this.emitter.clear();
  }

  on<K extends keyof RadioEvents>(event: K, fn: RadioEvents[K]): () => void {
    return this.emitter.on(event, fn);
  }
}

/**
 * Ouvre le sélecteur Bluetooth du navigateur, se connecte au module choisi et
 * attend la fin de sa configuration. La compatibilité de la plateforme a déjà
 * été vérifiée par l'appelant (bleRadio.ts).
 */
export async function createBleRadio(opts: BleRadioOptions = {}): Promise<Radio> {
  let transport: TransportWebBluetooth;
  try {
    transport = await TransportWebBluetooth.create();
  } catch (err) {
    // L'utilisateur a fermé le sélecteur, ou aucun module n'était appairable.
    const name = (err as { name?: string }).name;
    if (name === 'NotFoundError') {
      throw new BleUnavailableError(
        'Aucun module sélectionné. Vérifiez que le module est allumé, à portée, ' +
          'et qu’il n’est pas déjà connecté à un autre appareil.',
        'cancelled',
      );
    }
    throw new BleUnavailableError(`Connexion Bluetooth impossible : ${String(err)}`, 'connect-failed');
  }

  const device = new MeshDevice(transport);
  const radio = new BleRadio(device, opts.channel ?? Types.ChannelNumber.Primary);
  await device.configure();
  return radio;
}

