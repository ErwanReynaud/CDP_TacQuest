// Constantes de la couche mesh (Meshtastic / LoRa).
//
// Volontairement séparé de shared/src/constants.ts : ce dernier dimensionne le
// mode serveur (Socket.IO), dont les budgets sont sans rapport avec la radio.
// MAX_ORDER_BYTES y vaut 16 384 — 80 fois une trame LoRa.

/** Version du protocole applicatif TacQuest sur Meshtastic (nibble haut de l'octet 0). */
export const MESH_PROTOCOL_VERSION = 1;

/**
 * Budget utile d'une trame, en octets.
 *
 * `Constants.DATA_PAYLOAD_LEN` vaut 237 côté Meshtastic, mais le champ `payload`
 * d'un `Data` partage la place avec `portnum`, `dest`, `request_id`… On borne à
 * 200 : c'est la valeur du cahier des charges, et elle laisse de la marge pour
 * les en-têtes de routage. Tout encodage dépassant ce seuil est une erreur.
 */
export const MESH_MAX_PAYLOAD = 200;

/**
 * Portnum privé. Meshtastic réserve `PRIVATE_APP = 256` aux applications
 * tierces ; `ATAK_PLUGIN = 72` sert de référence de conception mais n'est
 * jamais émis par TacQuest (on n'usurpe pas le plugin d'un autre écosystème).
 */
export const PORTNUM_PRIVATE_APP = 256;
export const PORTNUM_POSITION_APP = 3;
export const PORTNUM_TEXT_MESSAGE_APP = 1;
export const PORTNUM_NODEINFO_APP = 4;
export const PORTNUM_WAYPOINT_APP = 8;
export const PORTNUM_ALERT_APP = 71;
export const PORTNUM_ATAK_PLUGIN = 72;
export const PORTNUM_STORE_FORWARD_APP = 65;
export const PORTNUM_ADMIN_APP = 6;

/** Opcodes (nibble bas de l'octet 0). 0x0-0x9 utilisés, 0xA-0xF réservés. */
export const OP = {
  ANCHOR: 0x0,
  WAYPOINT: 0x1,
  GRAPHIC: 0x2,
  REMOVE: 0x3,
  ACK: 0x4,
  TEXT: 0x5,
  CLEAR_ALL: 0x6,
  DIGEST: 0x7,
  REQ: 0x8,
  MEMBER: 0x9,
} as const;
export type Opcode = (typeof OP)[keyof typeof OP];

/** Opcodes porteurs d'un ordre CRDT (en-tête étendu : seq + horodatage). */
export const ORDER_OPCODES: readonly number[] = [
  OP.WAYPOINT, OP.GRAPHIC, OP.REMOVE, OP.ACK, OP.TEXT, OP.CLEAR_ALL,
];

/** Types de géométrie d'un ordre GRAPHIC (3 bits). */
export const GEOM = { LINE: 0, RECT: 1, POLY: 2 } as const;

/**
 * Palette fermée, 16 entrées : sur le fil une couleur est un index de 4 bits.
 * Les 3 premières sont celles réellement câblées dans l'UI actuelle
 * (`#e8d44d` par défaut des outils, `#0033ff` doctrine ami, `#d9a13b` mesure).
 * Une couleur hors palette est rabattue sur l'entrée la plus proche (perte
 * documentée, cf. docs/mesh/protocol.md § Dictionnaires).
 */
export const MESH_PALETTE: readonly string[] = [
  '#e8d44d', '#0033ff', '#d9a13b', '#ff3b30',
  '#34c759', '#ffffff', '#000000', '#ff9500',
  '#af52de', '#00c7be', '#8e8e93', '#a2845e',
  '#5856d6', '#ff2d55', '#30b0c7', '#c7c7cc',
];

/**
 * Dictionnaire SIDC. Seul HOSTILE_SIDC est posé par l'UI actuelle ; l'index 0
 * lui est réservé pour que le cas courant tienne en un octet.
 */
export const MESH_SIDC_DICT: readonly string[] = [
  'SHGPU----------', // HOSTILE_SIDC (plot ENI)
  'SFGPU----------', // ami générique
  'SNGPU----------', // neutre
  'SUGPU----------', // inconnu
];

/** Index « catalogue de mission inconnu » — rendu en ligne simple côté client. */
export const MISSION_UNKNOWN = 0xff;

/** Échelons APP-6 (cf. LineEchelon dans protocol.ts). */
export const ECHELONS = ['section', 'company', 'battalion'] as const;

/** Enveloppe d'une ancre : ±32 767 m sur chaque axe (int16, résolution 1 m). */
export const ANCHOR_RANGE_M = 32767;

/**
 * Durée de vie d'un tombstone, alignée sur ROOM_EMPTY_TTL_MS (24 h).
 * Au-delà, un nœud resté hors portée plus longtemps peut ressusciter un objet
 * supprimé — arbitrage add-wins assumé, cf. docs/mesh/protocol.md § CRDT.
 */
export const TOMBSTONE_TTL_MS = 24 * 60 * 60_000;

/** Nombre maximal d'entrées dans un DIGEST (1 + 32×6 = 193 o ≤ 200). */
export const DIGEST_MAX_ENTRIES = 32;

/**
 * Cadence de position en mode mesh. POSITION_INTERVAL_MS vaut 30 s côté
 * serveur ; sur LoRa, 40 nœuds à 30 s saturent le canal. Le gouverneur
 * d'airtime peut encore allonger cette valeur.
 */
export const MESH_POSITION_INTERVAL_MS = 120_000;

/** Duty cycle légal EU868, utilisé par le gouverneur d'airtime. */
export const DUTY_CYCLE_EU868 = 0.01;
