// Garde anti-dérive entre nos constantes de portnum et l'énumération Meshtastic.
//
// shared/ ne peut pas dépendre de @meshtastic/core (il tourne aussi côté
// serveur), les valeurs y sont donc écrites en dur. Ce test les confronte à la
// source : un portnum faux enverrait des trames que personne n'écoute, sans
// aucune erreur visible.

import { describe, expect, it } from 'vitest';
import { Protobuf } from '@meshtastic/core';
import {
  MESH_MAX_PAYLOAD,
  PORTNUM_ADMIN_APP,
  PORTNUM_ALERT_APP,
  PORTNUM_ATAK_PLUGIN,
  PORTNUM_NODEINFO_APP,
  PORTNUM_POSITION_APP,
  PORTNUM_PRIVATE_APP,
  PORTNUM_STORE_FORWARD_APP,
  PORTNUM_TEXT_MESSAGE_APP,
  PORTNUM_WAYPOINT_APP,
} from '@tq/shared/mesh/constants';

const P = Protobuf.Portnums.PortNum;

describe('portnums', () => {
  it('correspondent à l’énumération Meshtastic', () => {
    expect(PORTNUM_PRIVATE_APP).toBe(P.PRIVATE_APP);
    expect(PORTNUM_POSITION_APP).toBe(P.POSITION_APP);
    expect(PORTNUM_TEXT_MESSAGE_APP).toBe(P.TEXT_MESSAGE_APP);
    expect(PORTNUM_NODEINFO_APP).toBe(P.NODEINFO_APP);
    expect(PORTNUM_WAYPOINT_APP).toBe(P.WAYPOINT_APP);
    expect(PORTNUM_ALERT_APP).toBe(P.ALERT_APP);
    expect(PORTNUM_ATAK_PLUGIN).toBe(P.ATAK_PLUGIN);
    expect(PORTNUM_STORE_FORWARD_APP).toBe(P.STORE_FORWARD_APP);
    expect(PORTNUM_ADMIN_APP).toBe(P.ADMIN_APP);
  });

  it('tiennent le budget sous la limite de charge utile Meshtastic', () => {
    // DATA_PAYLOAD_LEN vaut 237 côté firmware ; on se borne à 200 pour laisser
    // la place aux en-têtes de routage.
    expect(MESH_MAX_PAYLOAD).toBeLessThanOrEqual(237);
  });
});
