// Source de vérité unique pour tout ce qui transite sur le réseau.
// Client et serveur typent leurs sockets contre ces interfaces.

export interface Position {
  lat: number;
  lng: number;
  /** Précision GPS en mètres. */
  accuracy: number;
  /** Cap en degrés (0 = nord), null si indisponible. */
  heading: number | null;
  /** Vitesse en m/s, null si indisponible. */
  speed: number | null;
  /** Horodatage du fix (epoch ms, horloge du client émetteur). */
  ts: number;
}

export interface MemberPublic {
  id: string;
  callsign: string;
  /** Poste dans l'arbre de commandement (cf. ROLE_REGEX) ; le client en dérive
   *  le figuré et la désignation (10/22/22A). */
  role: string;
  isLeader: boolean;
  connected: boolean;
  /** Dernière activité vue par le serveur (epoch ms serveur). */
  lastSeen: number;
  lastPosition: Position | null;
}

export interface RoomState {
  code: string;
  members: MemberPublic[];
  /** Vide en MVP ; les retardataires recevront les ordres par ce champ. */
  recentOrders: OrderMessage[];
}

// ---------------------------------------------------------------------------
// Ordres (phase 5) — enveloppe générique, jamais interprétée par le serveur.
// Un nouveau `kind` est un changement client uniquement.
// ---------------------------------------------------------------------------

/**
 * Figuré d'échelon APP-6 posé au centre d'une limite inter-unités :
 * trois points = section, une barre = compagnie, deux barres = bataillon.
 */
export type LineEchelon = 'section' | 'company' | 'battalion';

export interface GraphicStyle {
  color?: string;
  weight?: number;
  dashArray?: string;
  /** Pointe de flèche en bout de ligne (axe d'effort, direction). */
  arrow?: boolean;
  /** Nom affiché à un bout de la ligne (limite / sous-secteur). */
  label?: string;
  /** Figuré d'échelon dessiné au centre de la ligne (limite inter-unités). */
  echelon?: LineEchelon;
  /** Polygone fermé semi-transparent (box / zone) ; le nom se pose au centre. */
  polygon?: boolean;
  /** Figuré de mission (RECO, FIX, DEF…) dessiné le long de l'axe tracé ;
   *  identifiant du catalogue client (map/missions.ts), inconnu → ligne simple. */
  mission?: string;
}

export type OrderPayload =
  // Message libre du chat « Comms » (chacun peut en envoyer).
  | { kind: 'text'; body: string }
  // `sidc` → symbole milsymbol (plot ENI) ; `color` → rond de couleur + nom
  // (point nommé). Les deux s'excluent : `color` prime au rendu.
  | { kind: 'waypoint'; name: string; lat: number; lng: number; sidc?: string; color?: string }
  | { kind: 'graphic'; geojson: unknown; style?: GraphicStyle }
  | { kind: 'remove'; orderId: string }
  | { kind: 'ack'; orderId: string };

export interface OrderMessage {
  /** uuid généré côté client (ré-émission idempotente). */
  id: string;
  authorId: string;
  ts: number;
  kind: OrderPayload['kind'];
  payload: OrderPayload;
}

// ---------------------------------------------------------------------------
// Acks et erreurs
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'CALLSIGN_TAKEN'
  /** Indicatif tenu par un membre déconnecté : remplaçable via join_room { replace: true }. */
  | 'CALLSIGN_TAKEN_DISCONNECTED'
  /** Poste de commandement déjà occupé par un membre connecté. */
  | 'POST_TAKEN'
  /** Poste tenu par un membre déconnecté : remplaçable via join_room { replace: true }. */
  | 'POST_TAKEN_DISCONNECTED'
  | 'ROOM_FULL'
  | 'SERVER_FULL'
  | 'SESSION_INVALID'
  | 'INVALID_PAYLOAD'
  | 'RATE_LIMITED'
  | 'NOT_IN_ROOM';

export type Ack<T = Record<never, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: ErrorCode };

export interface JoinedRoom {
  roomCode: string;
  memberId: string;
  /** Secret de re-binding après reconnexion. Jamais diffusé aux autres. */
  sessionToken: string;
  roomState: RoomState;
}

// ---------------------------------------------------------------------------
// Événements Socket.IO
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  create_room: (
    p: { callsign: string; role: string },
    ack: (res: Ack<JoinedRoom>) => void,
  ) => void;
  join_room: (
    p: { roomCode: string; callsign: string; role: string; replace?: boolean },
    ack: (res: Ack<JoinedRoom>) => void,
  ) => void;
  rejoin_room: (
    p: { roomCode: string; memberId: string; sessionToken: string },
    ack: (res: Ack<{ roomState: RoomState }>) => void,
  ) => void;
  /** Fire-and-forget, throttlé serveur (POSITION_MIN_INTERVAL_MS). */
  position_update: (p: Position) => void;
  update_symbol: (p: { role: string }) => void;
  leave_room: () => void;
  send_order: (p: OrderMessage, ack: (res: Ack) => void) => void;
}

export interface ServerToClientEvents {
  /** Snapshot complet — réconciliation sans diff au (re)join. */
  room_state: (s: RoomState) => void;
  member_joined: (p: { member: MemberPublic }) => void;
  member_left: (p: { memberId: string; reason: 'left' | 'timeout' | 'kicked' }) => void;
  member_position: (p: { memberId: string; position: Position }) => void;
  member_updated: (p: { memberId: string; role?: string; connected?: boolean }) => void;
  /** `expired` = GC ; `closed` = clôture admin ; `kicked` = exclusion admin de CE membre. */
  room_closed: (p: { reason: 'expired' | 'closed' | 'kicked' }) => void;
  order: (o: OrderMessage) => void;
}
