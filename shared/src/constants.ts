// Limites et réglages partagés client/serveur.

// Sans 0/O/1/I/L : le code est destiné à être lu à la voix (radio).
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

export const MAX_ROOMS = 200;
export const MAX_MEMBERS_PER_ROOM = 40;

export const CALLSIGN_REGEX = /^[\p{L}\p{N} _-]{1,16}$/u;
// SIDC lettre (2525C, 10-15 car.) ou numérique (APP-6D, 20-30 chiffres).
// Le serveur ne l'interprète pas, il borne juste le format. Toujours utilisé
// pour valider le SIDC des plots ENI (cf. orders.ts, HOSTILE_SIDC).
export const SIDC_REGEX = /^[A-Za-z0-9*-]{10,30}$/;
export const DEFAULT_SIDC = 'SFGPE----------'; // CDS (rond, chef de section)
/** Losange rouge APP-6 : unité terrestre hostile, sans fonction (plots ENI).
 *  Ici et non dans client/map/symbols.ts, qui importe Leaflet : le codec mesh
 *  en a besoin, et un module de dictionnaire ne doit pas tirer le DOM. */
export const HOSTILE_SIDC = 'SHGP-------';

// Rôle d'un membre dans l'arbre hiérarchique de commandement :
//   CDU (unité) > CDS:S (section 1-3) > CDG:S:G (groupe 1-3) >
//   CDE:S:G:T (équipe A/B) > GV (grenadier-voltigeur, non contraint).
// Le client dérive de cette chaîne le figuré ET la désignation (10/22/22A).
// Le serveur borne le format et impose l'unicité des postes (sauf GV).
export const ROLE_REGEX = /^(CDU|GV|CDS:[1-3]|CDG:[1-3]:[1-3]|CDE:[1-3]:[1-3]:[AB])$/;
export const DEFAULT_ROLE = 'CDS:1'; // section 10, choix par défaut

// TTL glissant : une salle vit tant que quelqu'un s'y connecte, et meurt
// 24 h après la dernière connexion (pas de plafond dur depuis la création).
// Concrètement : jamais supprimée tant qu'un membre est connecté, puis
// compte à rebours de 24 h à partir du moment où elle n'a plus personne.
export const ROOM_EMPTY_TTL_MS = 24 * 60 * 60_000;
// Reconnexion : un membre déconnecté est conservé pendant la période de grâce
// (re-binding via sessionToken) et reste visible en grisé par les autres.
// 24 h : un téléphone mis en veille des heures, en zone blanche ou dont la PWA
// a été tuée par l'OS retrouve sa place. Au-delà, le fantôme est purgé — dans
// une salle encore vivante, l'indicatif redevient simplement libre.
export const DISCONNECT_GRACE_MS = ROOM_EMPTY_TTL_MS;
export const GC_INTERVAL_MS = 60_000;

// Anti-abus.
export const POSITION_MIN_INTERVAL_MS = 900;
export const ROOM_CREATE_PER_IP_PER_HOUR = 10;
export const FAILED_JOIN_DELAY_MS = 1_000;

// Throttle des ordres (graphiques, plots, chat, acks) par membre : anti-flood.
// Fenêtre fixe, volontairement généreuse — le tracé légitime, même en rafale,
// reste très en dessous ; au-delà, l'ordre est rejeté (RATE_LIMITED, transitoire
// côté client : conservé en file et retenté). Protège CPU/bande passante des
// autres clients et l'historique (ring buffer MAX_RECENT_ORDERS).
export const ORDER_MAX_PER_WINDOW = 50;
export const ORDER_WINDOW_MS = 10_000;

// Anti brute-force du code de salle : échecs de join (code inconnu) par IP sur
// une fenêtre glissante. Au-delà du seuil, l'IP est rejetée jusqu'à expiration.
// Seuil large (fautes de frappe légitimes) mais fini face aux 31^5 codes.
export const JOIN_FAIL_MAX = 20;
export const JOIN_FAIL_WINDOW_MS = 10 * 60_000;

// Console d'admin : verrouillage par IP après trop d'échecs d'authentification
// (anti brute-force du code admin). Au-delà du seuil dans la fenêtre, l'IP est
// rejetée (429) jusqu'à expiration de la fenêtre glissante.
export const ADMIN_AUTH_MAX_FAILS = 8;
export const ADMIN_AUTH_WINDOW_MS = 15 * 60_000;

// Ordres (phase 5 — le serveur les relaie sans les interpréter).
// Missions + accusés de réception s'accumulent : marge confortable.
export const MAX_RECENT_ORDERS = 250;
export const MAX_ORDER_BYTES = 16_384;

// Côté client : cadence d'échantillonnage de la position. Volontairement lente
// et en basse précision (récepteur GPS éteint entre deux fixes) — les batteries
// sont comptées sur le terrain. Un point dès l'arrivée sur le site, puis un
// point toutes les 30 s tant que la page est au premier plan (la géoloc écran
// verrouillé a été abandonnée).
export const POSITION_INTERVAL_MS = 30_000;
