// Constantes de la couche mesh (Meshtastic / LoRa).

import { HOSTILE_SIDC } from '../constants';
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
export const PORTNUM_ALERT_APP = 11;
export const PORTNUM_ATAK_PLUGIN = 72;
export const PORTNUM_STORE_FORWARD_APP = 65;
export const PORTNUM_ADMIN_APP = 6;

/** Opcodes (nibble bas de l'octet 0). 0x0-0xA utilisés, 0xB-0xF réservés. */
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
  /**
   * Relais d'un ordre dont nous ne sommes pas l'auteur.
   *
   * Les trames d'ordre élident le nœud auteur — le destinataire le reconstruit
   * depuis l'en-tête du paquet. Un tiers ne peut donc pas réémettre tel quel
   * l'ordre d'un autre : l'auteur serait reconstruit à son nom. RELAY enveloppe
   * la trame d'origine en portant l'auteur explicitement (4 octets), ce qui
   * permet à n'importe quel détenteur de servir un retardataire — le propre
   * d'un mesh.
   */
  RELAY: 0xa,
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
  HOSTILE_SIDC, // index 0 : plot ENI, le cas courant, tient en un octet
  'SFGP-------', // ami générique
  'SNGP-------', // neutre
  'SUGP-------', // inconnu
];

/**
 * Ordre de référence des figurés de mission sur le fil : l'index d'une mission
 * est sa position dans ce tableau.
 *
 * Contrat de compatibilité : on n'insère et on ne réordonne JAMAIS — une
 * nouvelle mission s'ajoute en fin de liste. Sans quoi deux nœuds de versions
 * différentes afficheraient chacun un figuré différent pour le même octet.
 * Un test client vérifie que cette liste couvre exactement MISSIONS.
 */
export const MESH_MISSION_IDS: readonly string[] = [
  'semp', 'app', 'appf', 'sout', 'neut', 'det', 'fix',
  'interd', 'def', 'ten', 'recu',
  'ecl', 'reco', 'couv', 'boucl', 'surv',
];

/** Index « catalogue de mission inconnu » — rendu en ligne simple côté client. */
export const MISSION_UNKNOWN = 0xff;

/** Échelons APP-6 (cf. LineEchelon dans protocol.ts). */
export const ECHELONS = ['section', 'company', 'battalion'] as const;

/** Enveloppe d'une ancre : ±32 767 m sur chaque axe (int16, résolution 1 m). */
export const ANCHOR_RANGE_M = 32767;

/** Surcoût d'une enveloppe RELAY : octet d'en-tête + numéro de nœud auteur. */
export const RELAY_OVERHEAD = 5;

/**
 * Durée de vie d'un tombstone, alignée sur ROOM_EMPTY_TTL_MS (24 h).
 * Au-delà, un nœud resté hors portée plus longtemps peut ressusciter un objet
 * supprimé — arbitrage add-wins assumé, cf. docs/mesh/protocol.md § CRDT.
 */
export const TOMBSTONE_TTL_MS = 24 * 60 * 60_000;

/** Nombre maximal d'entrées dans un DIGEST (1 + 32×6 = 193 o ≤ 200). */
export const DIGEST_MAX_ENTRIES = 32;

/**
 * Cadence d'émission d'un digest. Volontairement lente : c'est un filet de
 * sécurité, pas un canal de synchronisation. Trop rapide, il mangerait
 * l'airtime qu'il est censé préserver.
 */
export const DIGEST_INTERVAL_MS = 5 * 60_000;

/**
 * Gigue avant une réémission. Tous les nœuds qui détiennent un ordre manquant
 * le voient au même instant : sans délai aléatoire, ils répondraient tous
 * ensemble et se collisionneraient. Le premier à parler fait taire les autres
 * (cf. RESEND_SUPPRESSION_MS).
 */
export const RESEND_JITTER_MS = 15_000;

/**
 * Fenêtre de suppression : un ordre entendu récemment n'est pas réémis. C'est
 * ce qui transforme « tout le monde répond » en « un seul répond ».
 */
export const RESEND_SUPPRESSION_MS = 60_000;

/** Réémissions maximales déclenchées par un seul digest, pour borner la rafale. */
export const RESEND_MAX_PER_DIGEST = 8;

/**
 * Cadence de position en mode mesh. POSITION_INTERVAL_MS vaut 30 s côté
 * serveur ; sur LoRa, 40 nœuds à 30 s saturent le canal. Le gouverneur
 * d'airtime peut encore allonger cette valeur.
 */
export const MESH_POSITION_INTERVAL_MS = 120_000;

/** Duty cycle légal EU868, utilisé par le gouverneur d'airtime. */
export const DUTY_CYCLE_EU868 = 0.01;
