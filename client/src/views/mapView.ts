import L from 'leaflet';
import '../map/rotate'; // expose `L` au global (doit précéder leaflet-rotate)
import 'leaflet-rotate'; // patche L.Map avec setBearing()
import { startCompass, type CompassStop } from '../map/compass';
import { Protractor } from '../map/protractor';
import { POSITION_INTERVAL_MS } from '@tq/shared/constants';
import type { GraphicStyle, LineEchelon, MemberPublic, Position } from '@tq/shared/protocol';
import { bus, loadLastRoom, state } from '../state';
import { cycleCoordFormat, formatCoords, getCoordFormat, parseCoords, setCoordFormat, type CoordFormat } from '../coords';
import { cachedElevation, coordsWithAltitudeHtml, elevationKey, fetchElevation, hydrateAltitudes } from '../elevation';
import { connectForSession, leaveRoom, pendingOrderCount, restorePendingOrders, sendPosition } from '../transport';
import { offerSoloImport, orderAuthor, restoreSoloOrders, SOLO_AUTHOR, submitOrder } from '../soloOrders';
import { issueOrderId } from '../transport/orderIds';
import { attachMeshRadio, detachMesh, meshTransport } from '../transport';
import { BleUnavailableError, connectBleRadio, preloadBleRadio } from '../mesh/bleRadio';
import { bleSupport } from '../mesh/platform';
import { startGeolocation, type GeoWatcher } from '../geo';
import { dlog, formatLog, clearLog, onLog } from '../debugLog';
import { searchPlaces, type PlaceResult } from '../geocode';
import { CoordGrid, gridEnabled } from '../map/grid';
import { createBaseLayers, DEFAULT_LAYER } from '../map/layers';
import { MarkerLayer } from '../map/markers';
import { missionDef } from '../map/missionCatalog';
import { renderMission } from '../map/missions';
import { OrdersLayer } from '../map/orders';
import { visibleGraphics, visibleWaypoints, type WaypointOrder } from '../map/orderFilter';
import { PolylineSketch } from '../map/sketch';
import { HOSTILE_SIDC } from '../map/symbols';
import {
  checkIncomingMessages,
  closeComms,
  initCommsPanel,
  renderComms,
  resetCommsNotifications,
  unreadCommsCount,
} from './commsPanel';
import { closeTac, initTacPanel } from './tacPanel';
import { escapeHtml, formatDistance } from '../util';
import { openRoomMenu } from './roomMenu';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

let map: L.Map | null = null;
let markers: MarkerLayer | null = null;
let ordersLayer: OrdersLayer | null = null;
let geo: GeoWatcher | null = null;
let drawerTimer: ReturnType<typeof setInterval> | null = null;
let follow = true;
let hasCentered = false;
let busWired = false;
// Boussole : si actif, fonction d'arrêt de l'écoute ; bearing courant appliqué.
let compassStop: CompassStop | null = null;
let compassBearing = 0;
// Rapporteur (cercle trigo) : instancié à la création de la carte.
let protractor: Protractor | null = null;
// Quadrillage kilométrique UTM (option du tiroir).
let grid: CoordGrid | null = null;

// Outils d'esquisse présentés (chacun a un bouton #tool-<mode>) ; 'mission'
// se lance depuis le panneau Tac, sans bouton dédié.
type SketchMode = 'measure' | 'line' | 'arrow' | 'polygon' | 'mission';
const DISPLAYED_TOOLS = ['measure', 'line', 'arrow', 'polygon'] as const;
let sketch: PolylineSketch | null = null;
let sketchMode: SketchMode = 'measure';
let sketchColor = '#e8d44d';
// Figuré de mission en cours de tracé (mode 'mission') et son aperçu en
// direct (le figuré réel, semi-transparent, redessiné à chaque déplacement).
let pendingMission: string | null = null;
let missionPreview: L.Layer[] = [];
// Figurés à deux flèches (COUV/SURV/INTERD) : première flèche déjà validée,
// en attente du tracé de la seconde.
let missionFirstArm: L.LatLng[] | null = null;

/** Épaisseur de trait des figurés de mission (lisibles sur ortho). */
const MISSION_WEIGHT = 5;
// Tracé d'un liseré figé, en attente de finalisation par le menu contextuel.
let pendingLine: L.LatLng[] | null = null;
let pendingEchelon: LineEchelon | '' = '';
// Box (polygone) figée, en attente de nom.
let pendingBox: L.LatLng[] | null = null;
// Point nommé (rond de couleur) en attente de nom/couleur.
let pendingPoint: L.LatLng | null = null;
let pointColor = '#e8d44d';
// Plot ENI (losange rouge) en attente de texte.
let pendingEni: L.LatLng | null = null;
// Id de l'ordre en cours d'édition (menu point/ENI rouvert) : la validation
// réémet le même id (donc écrase le plot) au lieu d'en créer un nouveau.
let editId: string | null = null;
/** Démarrage sur la carte, avec ou sans session : en solo, seuls la géoloc et
 *  les outils locaux tournent — le socket ne se connecte qu'une fois en salle. */
export function enterMap(): void {
  const session = state.session;
  document.body.classList.toggle('solo', !session);

  if (!map) initLeaflet();
  // PWA iOS : le conteneur vient d'être affiché — resynchroniser la taille
  // Leaflet, sinon getCenter() (et donc les plots sous le réticule) dérive.
  requestAnimationFrame(() => map?.invalidateSize());
  markers?.setSelfId(session?.memberId ?? null);

  if (session) {
    $('room-code-btn').textContent = session.roomCode;
    markers?.sync(state.members);
    // Réaffiche d'éventuels ordres composés hors-ligne avant la reconnexion.
    restorePendingOrders();
    ordersLayer?.sync(state.orders);
    renderComms();
  } else {
    // Les figurés de la carte solo survivent en localStorage : rechargés à
    // chaque démarrage hors salle. Sync explicite : au boot, le bus n'est pas
    // encore câblé quand restoreSoloOrders émet 'orders'.
    restoreSoloOrders();
    ordersLayer?.sync(state.orders);
  }
  renderTopbar();
  renderDrawer();
  updateReadout();

  if (!busWired) {
    wireBus();
    busWired = true;
  }

  if (session) {
    connectForSession();
    // Garde à jour les libellés d'âge du tiroir (« il y a X min »), s'il est
    // ouvert — renderDrawer se court-circuite sinon. Cadencé sur les positions
    // (30 s) : pas besoin de plus fin, et c'est autant de batterie économisée.
    // Les marqueurs ne sont plus rafraîchis périodiquement : leur seul état
    // visuel (grisé = déconnecté) ne change que sur événement.
    drawerTimer ??= setInterval(renderDrawer, POSITION_INTERVAL_MS);
  }
  startGeo();
}

/** Bascule l'UI en mode salle après un create/join réussi (session déjà
 *  sauvegardée, room_state initial appliqué par le socket). */
export function enterRoomUi(): void {
  const session = state.session;
  if (!session) return;
  document.body.classList.remove('solo');
  $('room-code-btn').textContent = session.roomCode;
  markers?.setSelfId(session.memberId);
  markers?.sync(state.members);
  restorePendingOrders();
  ordersLayer?.sync(state.orders);
  renderTopbar();
  renderDrawer();
  renderComms();
  geo?.resend(); // pousse le fix courant tout de suite, sans attendre le cycle
  drawerTimer ??= setInterval(renderDrawer, POSITION_INTERVAL_MS);
  // S'il reste des figurés de la carte solo, proposer de les partager ici.
  offerSoloImport();
}

// --- boussole : carte « cap en haut » (mobile) ---

async function toggleCompass(): Promise<void> {
  if (compassStop) {
    stopCompass();
    return;
  }
  if (!map || typeof map.setBearing !== 'function') {
    toast('Rotation de carte non supportée sur cet appareil.');
    return;
  }
  const stop = await startCompass(applyHeading);
  if (!stop) {
    toast('Boussole indisponible sur cet appareil.');
    return;
  }
  compassStop = stop;
  $('tool-compass').classList.add('active');
  setFollow(true); // cap en haut : on recadre sur la position
}

function stopCompass(): void {
  compassStop?.();
  compassStop = null;
  $('tool-compass').classList.remove('active');
  compassBearing = 0;
  map?.setBearing(0);
  protractor?.update(); // réaligne l'anneau sur le nord (bearing 0)
}

// --- rapporteur (cercle trigo) : relevé d'azimut ---

function toggleProtractor(): void {
  if (!protractor) return;
  $('tool-protractor').classList.toggle('active', protractor.toggle());
}

/** Cap boussole → rotation carte (cap en haut). Seuil pour éviter de tourner à
 *  la cadence du capteur (~60 Hz) ; on ignore les variations < 1,5°. */
function applyHeading(heading: number): void {
  if (!map || !compassStop) return;
  const target = -heading;
  const delta = (((target - compassBearing) % 360) + 540) % 360 - 180;
  if (Math.abs(delta) < 1.5) return;
  compassBearing = target;
  map.setBearing(target);
  protractor?.update(); // garde l'anneau aligné sur le nord pendant la rotation
}

/** Sortie de salle (volontaire ou subie) : purge tout ce qui appartient à la
 *  salle mais laisse la carte vivante — géoloc, boussole, rapporteur et cadrage
 *  restent tels quels, on continue en solo. */
function exitToSolo(message?: string): void {
  cancelSketch();
  closeComms();
  resetCommsNotifications();
  $('drawer').hidden = true; // souvent ouvert : c'est de là qu'on quitte
  // Les figurés de la salle disparaissent, ceux de la carte solo reviennent.
  ordersLayer?.clear();
  restoreSoloOrders();
  ordersLayer?.sync(state.orders);
  if (drawerTimer) {
    clearInterval(drawerTimer);
    drawerTimer = null;
  }
  markers?.clearMembers();
  markers?.setSelfId(null);
  document.body.classList.add('solo');
  if (message) {
    toast(message, {
      label: 'Rejoindre',
      onClick: () => {
        $('toast').hidden = true;
        const last = loadLastRoom();
        openRoomMenu(last ? { code: last.roomCode, callsign: last.callsign } : undefined);
      },
    });
  }
}

function initLeaflet(): void {
  map = L.map('map', {
    center: [46.5, 2.5], // France, en attendant le premier fix
    zoom: 6,
    zoomControl: true,
    attributionControl: false,
    rotate: true, // active la rotation (boussole) ; bearing 0 = nord en haut
    rotateControl: false, // on fournit notre propre bouton
    touchRotate: false,
    shiftKeyRotate: false,
  });
  // Attribution des données (légalement requise) mais sans le préfixe « Leaflet ».
  L.control.attribution({ prefix: false }).addTo(map);
  const layers = createBaseLayers();
  layers[DEFAULT_LAYER]!.addTo(map);
  L.control.layers(layers, undefined, { position: 'topright' }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  // Le mode suivi se coupe dès que l'utilisateur déplace la carte.
  map.on('dragstart', () => setFollow(false));
  map.on('move', updateReadout);
  // Un appui sur la carte referme tiroir et panneaux (Comms, Tac) ouverts.
  map.on('click', () => {
    if (!$('drawer').hidden) $('drawer').hidden = true;
    if (!$('comms-panel').hidden) closeComms();
    closeTac();
  });
  // Rotation/redimensionnement (PWA, clavier, barre d'adresse) : resync taille.
  window.addEventListener('resize', () => map?.invalidateSize());
  window.addEventListener('orientationchange', () => setTimeout(() => map?.invalidateSize(), 200));

  protractor = new Protractor(map, $('protractor'), $('protractor-readout'));
  grid = new CoordGrid(map);

  // Créée une fois pour toute la vie de l'app : le point GPS local vit dedans,
  // en salle comme en solo ; seuls les marqueurs des coéquipiers vont et viennent.
  markers = new MarkerLayer(map, (id) => {
    if (sketch) return;
    const m = state.members.get(id);
    if (m) openMemberPopup(m);
  });

  const callsignOf = (id: string): string => {
    if (id === SOLO_AUTHOR) return 'moi';
    return (
      state.members.get(id)?.callsign ??
      (id === state.session?.memberId ? state.session.callsign : 'inconnu')
    );
  };

  ordersLayer = new OrdersLayer(map, {
    // Tous les membres ont les mêmes droits : chacun peut effacer/modifier un tracé/plot.
    canDelete: () => true,
    onDelete: (orderId) => void deleteOrder(orderId),
    onEdit: (w) => editPlot(w),
    authorName: callsignOf,
    selfLatLng: () => {
      // Dernier fix GPS local : disponible en salle comme en solo.
      const p = geo?.getLastFix();
      return p ? [p.lat, p.lng] : null;
    },
    isSketching: () => sketch !== null,
  });
}

function wireBus(): void {
  bus.on('members', () => {
    if (!markers) return;
    markers.sync(state.members);
    renderTopbar();
    renderDrawer();
  });

  bus.on('position', (memberId) => {
    const m = state.members.get(memberId as string);
    if (m && markers) markers.upsert(m);
  });

  bus.on('orders', () => {
    ordersLayer?.sync(state.orders);
    renderComms();
    checkIncomingMessages(); // toast + vibration sur message reçu
    renderTopbar(); // badges (éléments en attente + non-lus Comms)
  });

  bus.on('conn', () => renderConn());

  bus.on('rejoined', () => geo?.resend());

  bus.on('session-lost', (msg) => exitToSolo((msg as string) ?? 'Session expirée.'));
}

// --- géolocalisation ---
// Un point dès l'arrivée sur la carte, puis un envoi toutes les 30 s tant que
// la page est au premier plan. La géoloc écran verrouillé a été abandonnée.

function startGeo(): void {
  geo?.stop();
  geo = startGeolocation({
    send: (p) => sendPosition(p),
    onFix: (p) => onOwnFix(p),
    onDenied: () => {
      $('geo-overlay').hidden = false;
    },
  });
  if (!geo) $('geo-overlay').hidden = false;
}

function onOwnFix(p: Position): void {
  markers?.setSelf(p);
  const session = state.session;
  if (session) {
    // Le serveur n'écho pas nos propres positions : entrée roster synthétique,
    // dont dépendent le tiroir, Comms et la distance des plots (selfLatLng).
    let me = state.members.get(session.memberId);
    if (!me) {
      me = {
        id: session.memberId,
        callsign: session.callsign,
        role: session.role,
        isLeader: session.isLeader,
        connected: true,
        lastSeen: Date.now(),
        lastPosition: p,
      };
      state.members.set(me.id, me);
    } else {
      me.lastPosition = p;
      me.lastSeen = Date.now();
    }
  }
  if (follow || !hasCentered) {
    map?.setView([p.lat, p.lng], hasCentered ? map.getZoom() : 15);
    hasCentered = true;
  }
}

function setFollow(v: boolean): void {
  follow = v;
  $('btn-locate').classList.toggle('active', v);
}

// --- mesure et tracés (liserés / flèches) ---

/** Sélectionne une couleur d'esquisse (état + pastilles + tracé en cours). */
function selectSketchColor(color: string): void {
  sketchColor = color;
  document.querySelectorAll<HTMLButtonElement>('#sketch-colors .color-dot').forEach((el) => {
    el.classList.toggle('selected', el.dataset.color === color);
  });
  sketch?.setColor(color);
}

function setActiveTool(mode: SketchMode | null): void {
  for (const m of DISPLAYED_TOOLS) {
    $(`tool-${m}`).classList.toggle('active', m === mode);
  }
}

function startSketch(mode: SketchMode, missionId?: string): void {
  if (!map) return;
  cancelSketch(); // remet aussi pendingMission à null : le poser après
  sketchMode = mode;
  pendingMission = mode === 'mission' ? (missionId ?? null) : null;
  setFollow(false);
  setActiveTool(mode);

  const isMeasure = mode === 'measure';
  $('sketch-colors').hidden = isMeasure;
  $('sketch-ok').textContent = isMeasure ? 'Fermer' : 'Valider';
  const bar = $('sketchbar');
  if (isMeasure || mode === 'mission') {
    // Mesure et mission : la barre reste enfant de #map-screen et s'ancre en
    // bas-centre (hors de l'axe de visée). La mesure masquait le réticule
    // central qu'on pointe justement ; la mission n'a pas de bouton d'outil.
    bar.classList.add('measure-hud');
    $('map-screen').appendChild(bar);
  } else {
    // La barre contextuelle vient se loger à gauche du bouton de l'outil actif.
    const btn = $(`tool-${mode}`);
    bar.classList.remove('measure-hud');
    btn.parentElement!.insertBefore(bar, btn);
  }
  bar.hidden = false;

  spawnSketch();
}

/** (Re)crée l'esquisse pilotée au réticule — appelé au départ d'un outil et
 *  entre les deux flèches d'un figuré COUV/SURV/INTERD. */
function spawnSketch(): void {
  if (!map) return;
  const isMeasure = sketchMode === 'measure';
  // Un figuré de mission s'annonce dans la barre : « FIX · 250 m »
  // (« COUV 2/2 · 250 m » pour la seconde flèche d'un figuré double).
  const def = sketchMode === 'mission' && pendingMission ? missionDef(pendingMission) : undefined;
  const abbr = def ? `${def.abbr}${def.twoArrows ? (missionFirstArm ? ' 2/2' : ' 1/2') : ''}` : null;
  sketch = new PolylineSketch(map, {
    color: isMeasure ? '#d9a13b' : sketchColor,
    onChange: (_points, previewM) => {
      const dist = formatDistance(previewM);
      $('sketch-info').textContent = abbr ? `${abbr} · ${dist}` : dist;
      if (sketchMode === 'mission') updateMissionPreview();
    },
  });
  // Origine sous le réticule : déplacer la carte étire l'aperçu.
  sketch.addVertexAtCenter();
}

/** Aperçu en direct du figuré de mission : le dessin final, semi-transparent,
 *  recalculé sur l'axe origine → réticule à chaque déplacement de la carte.
 *  Pour un figuré double, la première flèche validée reste dans l'aperçu. */
function updateMissionPreview(): void {
  clearMissionPreview();
  if (!map || !sketch || !pendingMission) return;
  const def = missionDef(pendingMission);
  const pts = sketch.getFinalPoints();
  let seq: L.LatLng[];
  if (def?.twoArrows) {
    // Chaque flèche est réduite à ses extrémités (le rendu attend 0–1 / 2–3).
    const arm = pts.length >= 2 ? [pts[0]!, pts[pts.length - 1]!] : pts;
    seq = [...(missionFirstArm ?? []), ...arm];
  } else {
    seq = pts;
  }
  if (seq.length < 2) return;
  const latlngs = seq.map((p) => [p.lat, p.lng] as [number, number]);
  missionPreview = renderMission(map, pendingMission, latlngs, sketchColor, MISSION_WEIGHT, {
    interactive: false,
    opacity: 0.55,
  });
  for (const l of missionPreview) l.addTo(map);
}

function clearMissionPreview(): void {
  for (const l of missionPreview) l.remove();
  missionPreview = [];
}

/** Depuis le panneau Tac : trace l'axe du figuré (origine → réticule). Les
 *  figurés amis sont bleus par doctrine : présélectionne cette couleur. */
function startMissionSketch(missionId: string): void {
  selectSketchColor('#0033ff');
  startSketch('mission', missionId);
}

function cancelSketch(): void {
  sketch?.destroy();
  sketch = null;
  clearMissionPreview();
  pendingMission = null;
  missionFirstArm = null;
  $('sketchbar').hidden = true;
  setActiveTool(null);
}

function finishSketch(): void {
  if (!sketch) return;
  const mode = sketchMode;
  if (mode === 'measure') {
    cancelSketch(); // la mesure est purement locale
    return;
  }
  // « OK » prend la position courante du réticule comme dernier sommet.
  const points = sketch.getFinalPoints();
  if (points.length < 2) {
    toast('Déplacez la carte pour tracer.');
    return;
  }
  if (mode === 'arrow') {
    cancelSketch();
    sendGraphic(points, { color: sketchColor, weight: 4, arrow: true });
    return;
  }
  if (mode === 'mission') {
    const mission = pendingMission;
    const def = mission ? missionDef(mission) : undefined;
    const arm = [points[0]!, points[points.length - 1]!];
    if (def?.twoArrows && !missionFirstArm) {
      // Première flèche validée : on enchaîne sur le tracé de la seconde.
      missionFirstArm = arm;
      sketch?.destroy();
      spawnSketch();
      toast('Première flèche posée — tracez la seconde.');
      return;
    }
    // Figuré double : points 0–1 = 1re flèche, 2–3 = 2de (cf. renderMission).
    const all = def?.twoArrows && missionFirstArm ? [...missionFirstArm, ...arm] : points;
    cancelSketch();
    if (mission) sendGraphic(all, { color: sketchColor, weight: MISSION_WEIGHT, mission });
    return;
  }
  if (mode === 'polygon') {
    if (points.length < 3) {
      toast('Posez au moins 3 sommets pour une box.');
      return;
    }
    freezeAndHideSketchbar();
    openBoxMenu(points);
    return;
  }
  // Liseré : on fige le tracé (il reste visible) et on ouvre le menu de
  // finalisation (nom + figuré d'échelon) ; rien n'est transmis avant Valider.
  freezeAndHideSketchbar();
  openLineMenu(points);
}

/** Transmet un ordre graphique — vers la salle (optimiste + file hors-ligne),
 *  ou appliqué à la carte solo persistée (voir submitOrder). */
function sendGraphic(points: L.LatLng[], style: GraphicStyle): void {
  submitOrder({
    id: issueOrderId(),
    authorId: orderAuthor(),
    ts: Date.now(),
    kind: 'graphic',
    payload: {
      kind: 'graphic',
      geojson: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
      },
      style,
    },
  });
}

function openLineMenu(points: L.LatLng[]): void {
  pendingLine = points;
  pendingEchelon = '';
  const input = $<HTMLInputElement>('line-name');
  input.value = '';
  selectEchelon('');
  $('line-menu').hidden = false;
  input.focus();
}

/** Met en évidence le figuré choisi (et mémorise la sélection). */
function selectEchelon(echelon: LineEchelon | ''): void {
  pendingEchelon = echelon;
  document.querySelectorAll<HTMLButtonElement>('.line-ech').forEach((btn) => {
    btn.classList.toggle('selected', (btn.dataset.echelon ?? '') === echelon);
  });
}

function confirmLineMenu(): void {
  if (!pendingLine) return;
  const style: GraphicStyle = { color: sketchColor, weight: 4 };
  const name = $<HTMLInputElement>('line-name').value.trim();
  if (name) style.label = name;
  if (pendingEchelon) style.echelon = pendingEchelon;
  sendGraphic(pendingLine, style);
  closeLineMenu();
}

/** Fige le tracé en cours (il reste visible) et range la barre d'esquisse. */
function freezeAndHideSketchbar(): void {
  sketch?.freeze();
  $('sketchbar').hidden = true;
  setActiveTool(null);
}

/** Ferme le menu et détruit le tracé figé (qu'il ait été transmis ou non). */
function closeLineMenu(): void {
  $('line-menu').hidden = true;
  pendingLine = null;
  cancelSketch();
}

// --- box (polygone semi-transparent + nom au centre) ---
// Réutilise le système de lignes : on dessine les sommets au réticule, puis un
// menu contextuel demande le nom. La couleur vient du sketchbar (comme les lignes).

function openBoxMenu(points: L.LatLng[]): void {
  pendingBox = points;
  const input = $<HTMLInputElement>('box-name');
  input.value = '';
  $('box-menu').hidden = false;
  input.focus();
}

function confirmBoxMenu(): void {
  if (!pendingBox) return;
  const name = $<HTMLInputElement>('box-name').value.trim();
  const style: GraphicStyle = { color: sketchColor, weight: 3, polygon: true };
  if (name) style.label = name;
  sendGraphic(pendingBox, style);
  closeBoxMenu();
}

function closeBoxMenu(): void {
  $('box-menu').hidden = true;
  pendingBox = null;
  cancelSketch();
}

// --- point nommé (rond de couleur + texte, accessible à tous) ---
// Tap sur l'outil = capture du point sous le réticule, puis menu nom + couleur.

function beginPoint(): void {
  if (!map) return;
  cancelSketch();
  editId = null; // création, pas édition
  pendingPoint = map.getCenter();
  const input = $<HTMLInputElement>('point-name');
  input.value = '';
  $('point-menu').hidden = false;
  input.focus();
}

function confirmPointMenu(): void {
  if (!pendingPoint) return;
  const name = $<HTMLInputElement>('point-name').value.trim() || 'Point';
  const c = pendingPoint;
  submitOrder({
    id: editId ?? issueOrderId(), // même id en édition → écrase le plot
    authorId: orderAuthor(),
    ts: Date.now(),
    kind: 'waypoint',
    payload: { kind: 'waypoint', name, lat: c.lat, lng: c.lng, color: pointColor },
  });
  closePointMenu();
}

function closePointMenu(): void {
  $('point-menu').hidden = true;
  pendingPoint = null;
  editId = null;
}

/** Efface tous les figurés et tracés visibles — pour toute la salle si on y
 *  est (chacun a les mêmes droits), sinon la carte solo. Confirmation requise. */
function clearWholeMap(): void {
  const count = visibleGraphics(state.orders).length + visibleWaypoints(state.orders).length;
  if (count === 0) {
    toast('Rien à effacer.');
    return;
  }
  const target = state.session ? 'de la salle (pour tout le monde)' : 'de la carte';
  if (!confirm(`Effacer les ${count} figuré(s) et tracé(s) ${target} ?`)) return;
  // Un seul ordre `clear` borné dans le temps, au lieu d'un `remove` par
  // figuré : sur LoRa, effacer une carte chargée coûtait 40 paquets, et en
  // mode serveur cela consommait d'un coup la moitié du quota anti-flood.
  submitOrder({
    id: issueOrderId(),
    authorId: orderAuthor(),
    ts: Date.now(),
    kind: 'clear',
    payload: { kind: 'clear', beforeTs: Date.now() },
  });
  $('drawer').hidden = true;
}

function deleteOrder(orderId: string): void {
  submitOrder({
    id: issueOrderId(),
    authorId: orderAuthor(),
    ts: Date.now(),
    kind: 'remove',
    payload: { kind: 'remove', orderId },
  });
}

// --- plot ennemi (losange rouge, accessible à tous) ---
// Tap sur l'outil = capture du réticule, puis menu texte (réutilise le système
// du point nommé) ; le texte devient la désignation affichée près du losange.

function beginEni(): void {
  if (!map) return;
  cancelSketch(); // un plot ENI interrompt une éventuelle esquisse en cours
  editId = null; // création, pas édition
  pendingEni = map.getCenter();
  const input = $<HTMLInputElement>('eni-name');
  input.value = '';
  $('eni-menu').hidden = false;
  input.focus();
}

function confirmEniMenu(): void {
  if (!pendingEni) return;
  const name = $<HTMLInputElement>('eni-name').value.trim() || 'ENI';
  const c = pendingEni;
  submitOrder({
    id: editId ?? issueOrderId(), // même id en édition → écrase le plot
    authorId: orderAuthor(),
    ts: Date.now(),
    kind: 'waypoint',
    payload: { kind: 'waypoint', name, lat: c.lat, lng: c.lng, sidc: HOSTILE_SIDC },
  });
  closeEniMenu();
}

function closeEniMenu(): void {
  $('eni-menu').hidden = true;
  pendingEni = null;
  editId = null;
}

/**
 * Rééditer un plot : rouvre le menu adéquat (point nommé si `color`, sinon ENI)
 * prérempli, en conservant la position d'origine ; la validation réémet l'ordre
 * avec le même id (cf. `editId`), écrasant le plot chez tout le monde.
 */
function editPlot(w: WaypointOrder): void {
  if (!map) return;
  cancelSketch();
  closePointMenu();
  closeEniMenu();
  editId = w.id;
  if (w.color != null) {
    pendingPoint = L.latLng(w.lat, w.lng);
    pointColor = w.color;
    document.querySelectorAll<HTMLElement>('#point-colors .color-dot').forEach((el) => {
      el.classList.toggle('selected', el.dataset.color === w.color);
    });
    const input = $<HTMLInputElement>('point-name');
    input.value = w.name;
    $('point-menu').hidden = false;
    input.focus();
  } else {
    pendingEni = L.latLng(w.lat, w.lng);
    const input = $<HTMLInputElement>('eni-name');
    input.value = w.name;
    $('eni-menu').hidden = false;
    input.focus();
  }
}

// --- coordonnées (réticule central + popups) ---

let elevTimer: ReturnType<typeof setTimeout> | null = null;

function updateReadout(): void {
  if (!map) return;
  const c = map.getCenter();
  // Altitude du point visé en dernier groupe, même police : « … 14018 43518 158 ».
  // Affichée seulement si on la connaît déjà pour ce point : on évite ainsi tout
  // chiffre périmé hérité d'un endroit qu'on vient de quitter en panoramique.
  const coords = formatCoords(c.lat, c.lng);
  const alt = cachedElevation(c.lat, c.lng);
  $('coord-readout').textContent = alt !== null ? `${coords} ${Math.round(alt)}` : coords;
  scheduleElevation(c.lat, c.lng);
}

/** Va chercher l'altitude du centre une fois la carte stabilisée (débounce). */
function scheduleElevation(lat: number, lng: number): void {
  if (cachedElevation(lat, lng) !== null) return; // déjà affichée
  if (elevTimer) clearTimeout(elevTimer);
  elevTimer = setTimeout(() => {
    void fetchElevation(lat, lng).then((alt) => {
      if (alt === null || !map) return;
      // N'applique le résultat que si le réticule est resté sur ce point.
      const c = map.getCenter();
      if (elevationKey(c.lat, c.lng) === elevationKey(lat, lng)) updateReadout();
    });
  }, 500);
}

// --- aller à des coordonnées saisies (MGRS ou lat/lng) ---

function openCoordSearch(): void {
  const input = $<HTMLInputElement>('coord-search-input');
  // Préremplissage avec la position actuelle (mon fix GPS, sinon le centre carte)
  // dans un format relisible par parseCoords : l'UTM n'étant pas parsé, on le
  // rabat sur MGRS.
  const here = geo?.getLastFix() ?? map?.getCenter() ?? null;
  const fmt = getCoordFormat();
  input.value = here ? formatCoords(here.lat, here.lng, fmt === 'utm' ? 'mgrs' : fmt) : '';
  $('coord-search-error').hidden = true;
  $('coord-search-menu').hidden = false;
  input.focus();
  input.select(); // sélection : on tape par-dessus, ou on ajuste
}

function confirmCoordSearch(): void {
  if (!map) return;
  const parsed = parseCoords($<HTMLInputElement>('coord-search-input').value);
  if (!parsed) {
    $('coord-search-error').hidden = false;
    return;
  }
  setFollow(false); // on va à un point précis : plus de recadrage auto
  map.setView([parsed.lat, parsed.lng], Math.max(map.getZoom(), 15));
  $('coord-search-menu').hidden = true;
}

function closeCoordSearch(): void {
  $('coord-search-menu').hidden = true;
}

// --- recherche de lieu (géocodage IGN : communes, adresses, lieux-dits) ---

let placeTimer: ReturnType<typeof setTimeout> | null = null;
let placeAbort: AbortController | null = null;
let placeResults: PlaceResult[] = [];

function openPlaceSearch(): void {
  const input = $<HTMLInputElement>('place-input');
  input.value = '';
  renderPlaceResults([]);
  placeStatus(null);
  $('place-menu').hidden = false;
  input.focus();
}

function closePlaceSearch(): void {
  $('place-menu').hidden = true;
  placeAbort?.abort();
  placeAbort = null;
  if (placeTimer) {
    clearTimeout(placeTimer);
    placeTimer = null;
  }
}

function placeStatus(msg: string | null): void {
  const el = $('place-status');
  el.hidden = !msg;
  el.textContent = msg ?? '';
}

/** Saisie → recherche débouncée ; une frappe annule la requête en vol. */
function onPlaceInput(): void {
  const q = $<HTMLInputElement>('place-input').value.trim();
  if (placeTimer) clearTimeout(placeTimer);
  placeAbort?.abort();
  placeAbort = null;
  if (q.length < 3) {
    renderPlaceResults([]);
    placeStatus(null);
    return;
  }
  placeTimer = setTimeout(() => {
    const ctrl = new AbortController();
    placeAbort = ctrl;
    searchPlaces(q, ctrl.signal)
      .then((results) => {
        if (ctrl.signal.aborted) return;
        renderPlaceResults(results);
        placeStatus(results.length ? null : 'Aucun résultat.');
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name === 'AbortError') return;
        renderPlaceResults([]);
        placeStatus('Recherche indisponible (hors-ligne ?).');
      });
  }, 300);
}

function renderPlaceResults(results: PlaceResult[]): void {
  placeResults = results;
  const list = $('place-results');
  list.hidden = results.length === 0;
  list.replaceChildren();
  for (const [i, r] of results.entries()) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'place-result';
    const name = document.createElement('span');
    name.textContent = r.name;
    const ctx = document.createElement('small');
    ctx.textContent = r.context;
    btn.append(name, ctx);
    btn.addEventListener('click', () => goToPlace(i));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function goToPlace(index: number): void {
  const r = placeResults[index];
  if (!r || !map) return;
  closePlaceSearch();
  setFollow(false); // on va à un lieu précis : plus de recadrage auto
  map.setView([r.lat, r.lng], Math.max(map.getZoom(), 14));
}

function renderCoordFormat(): void {
  const fmt = getCoordFormat();
  document.querySelectorAll<HTMLButtonElement>('#coord-format button').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.fmt === fmt);
  });
}

function openMemberPopup(m: MemberPublic): void {
  if (!map || !m.lastPosition) return;
  const p = m.lastPosition;
  const div = document.createElement('div');
  div.className = 'order-popup';
  div.innerHTML =
    `<b>${escapeHtml(m.callsign)}</b>` +
    coordsWithAltitudeHtml(p.lat, p.lng) +
    `<span class="order-author">±${Math.round(p.accuracy)} m · ${memberMeta(m, Date.now())}</span>`;
  hydrateAltitudes(div);
  L.popup({ className: 'tq-popup' }).setLatLng([p.lat, p.lng]).setContent(div).openOn(map);
}

// --- rendu UI ---

function renderConn(): void {
  const dot = $('conn-dot');
  dot.className = `conn-${state.conn}`;
  dot.title =
    state.conn === 'connected' ? 'Connecté'
    : state.conn === 'reconnecting' ? 'Reconnexion…'
    : 'Hors ligne';
}

function renderTopbar(): void {
  const connected = [...state.members.values()].filter((m) => m.connected).length;
  $('member-count').textContent = String(connected);
  const pending = pendingOrderCount();
  const badge = $('pending-badge');
  badge.hidden = pending === 0;
  badge.textContent = pending > 0 ? `↑${pending}` : '';
  badge.title = pending > 0 ? `${pending} élément(s) à synchroniser` : '';

  // Badge du bouton « Comms » : messages reçus non lus.
  const unread = unreadCommsCount();
  const cb = $('comms-badge');
  cb.hidden = unread === 0;
  cb.textContent = String(unread);

  renderConn();
}

function renderDrawer(): void {
  const drawer = $('drawer');
  if (drawer.hidden) return;
  const list = $('member-list');
  list.innerHTML = '';
  const now = Date.now();
  const sorted = [...state.members.values()].sort((a, b) => a.callsign.localeCompare(b.callsign));
  for (const m of sorted) {
    const li = document.createElement('li');
    if (!m.connected) li.classList.add('offline');
    const meta = memberMeta(m, now);
    li.innerHTML =
      `<span class="m-callsign">${escapeHtml(m.callsign)}</span>` +
      `<span class="m-meta">${meta}</span>`;
    if (m.lastPosition) {
      const btn = document.createElement('button');
      btn.className = 'btn m-center';
      btn.textContent = 'Centrer';
      btn.addEventListener('click', () => {
        setFollow(false);
        map?.setView([m.lastPosition!.lat, m.lastPosition!.lng], Math.max(map.getZoom(), 14));
        drawer.hidden = true;
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

function memberMeta(m: MemberPublic, now: number): string {
  if (!m.connected) return ago(now - m.lastSeen);
  if (!m.lastPosition) return 'pas de position';
  return ago(now - Math.max(m.lastPosition.ts, m.lastSeen), 'à jour');
}

/** « il y a X s / min ». En deçà de `fresh` secondes, renvoie le libellé frais. */
function ago(ms: number, fresh = ''): string {
  const s = Math.floor(ms / 1000);
  if (fresh && s < 15) return fresh;
  if (s < 60) return `il y a ${s} s`;
  return `il y a ${Math.floor(s / 60)} min`;
}

export function initMapView(): void {
  // Panneau latéral « Comms » (chat libre de la salle).
  initCommsPanel({ notify: (text) => toast(text) });
  // Panneau « Tac » : figurés de mission.
  initTacPanel({ startMission: startMissionSketch });

  for (const mode of DISPLAYED_TOOLS) {
    $(`tool-${mode}`).addEventListener('click', () => {
      // Re-choisir l'outil actif annule l'esquisse en cours.
      if (sketch && sketchMode === mode) cancelSketch();
      else startSketch(mode);
    });
  }
  $('tool-eni').addEventListener('click', () => beginEni());
  // Bascule du menu d'outils (paysage / faible hauteur).
  $('fab-toggle').addEventListener('click', () => {
    const open = $('fab-stack').classList.toggle('open');
    $('fab-toggle').setAttribute('aria-expanded', String(open));
  });
  $('eni-ok').addEventListener('click', confirmEniMenu);
  $('eni-cancel').addEventListener('click', closeEniMenu);
  $('tool-compass').addEventListener('click', () => void toggleCompass());
  $('tool-protractor').addEventListener('click', toggleProtractor);
  $('sketch-add').addEventListener('click', () => sketch?.addVertexAtCenter());

  // Recherche de lieu (haut gauche) : communes, adresses, lieux-dits IGN.
  $('btn-place').addEventListener('click', openPlaceSearch);
  $('place-cancel').addEventListener('click', closePlaceSearch);
  $<HTMLInputElement>('place-input').addEventListener('input', onPlaceInput);
  $<HTMLInputElement>('place-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') goToPlace(0); // premier résultat
  });
  $('place-menu').addEventListener('click', (e) => {
    if (e.target === $('place-menu')) closePlaceSearch();
  });

  // Recherche de coordonnées (loupe) : saisie MGRS / lat-lng puis « Y aller ».
  $('coord-search').addEventListener('click', openCoordSearch);
  $('coord-search-ok').addEventListener('click', confirmCoordSearch);
  $('coord-search-cancel').addEventListener('click', closeCoordSearch);
  $<HTMLInputElement>('coord-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmCoordSearch();
  });

  // Format de coordonnées : tap sur l'affichage = cycle, tiroir = choix direct.
  $('coord-readout').addEventListener('click', cycleCoordFormat);
  document.querySelectorAll<HTMLButtonElement>('#coord-format button').forEach((btn) => {
    btn.addEventListener('click', () => setCoordFormat(btn.dataset.fmt as CoordFormat));
  });
  renderCoordFormat();
  bus.on('coordfmt', () => {
    updateReadout();
    renderCoordFormat();
  });

  // Quadrillage kilométrique : bascule Affiché / Masqué dans le tiroir.
  const renderGridToggle = (): void => {
    document.querySelectorAll<HTMLButtonElement>('#grid-toggle button').forEach((btn) => {
      btn.classList.toggle('selected', (btn.dataset.grid === 'on') === gridEnabled());
    });
  };
  document.querySelectorAll<HTMLButtonElement>('#grid-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      grid?.setEnabled(btn.dataset.grid === 'on');
      renderGridToggle();
    });
  });
  renderGridToggle();

  // --- panneau de diagnostic veille (masqué — conservé pour un usage ultérieur) ---
  let diagUnsub: (() => void) | null = null;
  const renderDiag = (): void => {
    const pre = $('diag-log');
    pre.textContent = formatLog() || '(journal vide — verrouille puis déverrouille)';
    pre.scrollTop = pre.scrollHeight;
  };
  $('btn-diag').addEventListener('click', () => {
    $('drawer').hidden = true;
    $('diag-overlay').hidden = false;
    renderDiag();
    diagUnsub = onLog(renderDiag); // mise à jour en direct tant que le panneau est ouvert
  });
  const closeDiag = (): void => {
    $('diag-overlay').hidden = true;
    diagUnsub?.();
    diagUnsub = null;
  };
  $('diag-close').addEventListener('click', closeDiag);
  $('diag-clear').addEventListener('click', () => {
    clearLog();
    dlog('diag', 'journal vidé');
  });
  $('diag-copy').addEventListener('click', () => {
    const txt = formatLog();
    void navigator.clipboard?.writeText(txt).then(
      () => toast('Journal copié'),
      () => toast('Copie impossible — sélectionne le texte à la main'),
    );
  });
  $('sketch-ok').addEventListener('click', () => void finishSketch());
  $('sketch-cancel').addEventListener('click', cancelSketch);
  $('sketch-undo').addEventListener('click', () => sketch?.undo());

  // Menu contextuel du liseré : choix du figuré d'échelon + valider / annuler.
  document.querySelectorAll<HTMLButtonElement>('.line-ech').forEach((btn) => {
    btn.addEventListener('click', () => selectEchelon((btn.dataset.echelon ?? '') as LineEchelon | ''));
  });
  $('line-ok').addEventListener('click', confirmLineMenu);
  $('line-cancel').addEventListener('click', closeLineMenu);
  $('box-ok').addEventListener('click', confirmBoxMenu);
  $('box-cancel').addEventListener('click', closeBoxMenu);

  // Outil point nommé + son menu (nom + couleur du rond).
  $('tool-point').addEventListener('click', () => beginPoint());
  document.querySelectorAll<HTMLButtonElement>('#point-colors .color-dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      pointColor = dot.dataset.color!;
      document.querySelectorAll('#point-colors .color-dot').forEach((el) => el.classList.remove('selected'));
      dot.classList.add('selected');
    });
  });
  $('point-ok').addEventListener('click', confirmPointMenu);
  $('point-cancel').addEventListener('click', closePointMenu);
  document.querySelectorAll<HTMLButtonElement>('#sketch-colors .color-dot').forEach((dot, i) => {
    if (i === 0) dot.classList.add('selected');
    dot.addEventListener('click', () => selectSketchColor(dot.dataset.color!));
  });

  $('btn-locate').addEventListener('click', () => {
    setFollow(true);
    geo?.refresh(); // acquisition GPS fraîche ; onOwnFix recentrera en mode suivi
    const fix = geo?.getLastFix();
    if (fix) map?.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 15));
  });

  $('btn-members').addEventListener('click', () => {
    const drawer = $('drawer');
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) renderDrawer();
  });

  $('btn-mesh').addEventListener('click', () => void toggleMesh());
  renderMesh();
  // Met le code radio en cache tant qu'il y a du réseau : sur le terrain, il
  // sera trop tard.
  preloadBleRadio();

  $('btn-room').addEventListener('click', () => openRoomMenu());
  $('btn-clear-map').addEventListener('click', clearWholeMap);

  $('btn-leave').addEventListener('click', () => {
    if (!confirm('Quitter la salle ?')) return;
    leaveRoom();
    exitToSolo();
  });

  $('room-code-btn').addEventListener('click', async () => {
    const code = state.session?.roomCode;
    if (!code) return;
    const text = `Rejoignez ma salle TacticalQuest : ${code} — ${location.origin}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(code);
        toast('Code copié.');
      }
    } catch {
      /* partage annulé */
    }
  });

  $('btn-geo-retry').addEventListener('click', () => {
    $('geo-overlay').hidden = true;
    startGeo();
  });
  $('btn-geo-dismiss').addEventListener('click', () => {
    $('geo-overlay').hidden = true;
  });
}

// --- liaison radio (module Meshtastic en Bluetooth) ---

function setMeshStatus(text: string, tone: 'ok' | 'ko' | 'neutral'): void {
  const el = $('mesh-status');
  el.textContent = text;
  el.className = `mesh-status${tone === 'neutral' ? '' : ` mesh-${tone}`}`;
  el.hidden = !text;
}

/** Reflète l'état de la liaison sur le bouton et la ligne d'état du tiroir. */
function renderMesh(): void {
  const btn = $<HTMLButtonElement>('btn-mesh');
  const mesh = meshTransport();
  if (mesh) {
    btn.textContent = 'Déconnecter';
    setMeshStatus('Module radio connecté.', 'ok');
    return;
  }
  btn.textContent = 'Connecter';
  // Sur une plateforme incapable, on l'annonce sans attendre que
  // l'utilisateur tente la connexion et échoue : le bouton reste inerte, et
  // le motif exact est affiché (cf. mesh/platform.ts).
  const support = bleSupport();
  if (!support.supported) {
    btn.disabled = true;
    setMeshStatus(support.message, 'ko');
  } else {
    setMeshStatus('', 'neutral');
  }
}

async function toggleMesh(): Promise<void> {
  if (meshTransport()) {
    detachMesh();
    renderMesh();
    toast('Module radio déconnecté.');
    return;
  }
  const btn = $<HTMLButtonElement>('btn-mesh');
  btn.disabled = true;
  setMeshStatus('Recherche du module…', 'neutral');
  try {
    const radio = await connectBleRadio();
    const mesh = attachMeshRadio(radio, (m) => dlog('mesh', m));
    if (state.session) mesh.announce(state.session.callsign);
    // Un fix déjà acquis établit l'ancre de zone tout de suite, au lieu
    // d'attendre le cycle de géolocalisation suivant.
    const fix = geo?.getLastFix();
    if (fix) mesh.ensureAnchor(fix.lat, fix.lng);
    radio.on('status', () => renderMesh());
    toast('Module radio connecté.');
  } catch (err) {
    const message =
      err instanceof BleUnavailableError ? err.message : `Connexion impossible : ${String(err)}`;
    setMeshStatus(message, 'ko');
    dlog('mesh', message);
  } finally {
    btn.disabled = false;
    renderMesh();
  }
}

export function toast(text: string, action?: { label: string; onClick: () => void }): void {
  const el = $('toast');
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.onClick;
  }
  el.hidden = false;
  if (!action) setTimeout(() => (el.hidden = true), 4_000);
}
