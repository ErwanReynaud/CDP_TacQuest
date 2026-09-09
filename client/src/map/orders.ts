import L from 'leaflet';
import { SIDC_REGEX } from '@tq/shared/constants';
import type { LineEchelon, OrderMessage } from '@tq/shared/protocol';
import { coordsWithAltitudeHtml, hydrateAltitudes } from '../elevation';
import { distanceM } from '../geo';
import { escapeHtml, formatDistance, safeColor } from '../util';
import { missionDef } from './missionCatalog';
import { renderMission } from './missions';
import { visibleGraphics, visibleWaypoints, type GraphicOrder, type WaypointOrder } from './orderFilter';
import { getPlotIcon, HOSTILE_SIDC } from './symbols';

const DEFAULT_COLOR = '#e8d44d';
const HEAD_LENGTH_PX = 16;
const HEAD_SPREAD_RAD = Math.PI / 6;

/** ~1 m près de l'équateur : en dessous, deux taps sont le même point. */
function isSamePoint(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
}

/** Point à mi-longueur cumulée, et le segment qui le porte (pour l'orientation). */
interface MidPoint {
  at: [number, number];
  a: [number, number];
  b: [number, number];
}
function midpointAlong(pts: [number, number][]): MidPoint | null {
  if (pts.length < 2) return null;
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = distanceM(
      { lat: pts[i - 1]![0], lng: pts[i - 1]![1] },
      { lat: pts[i]![0], lng: pts[i]![1] },
    );
    segs.push(d);
    total += d;
  }
  if (total === 0) return { at: pts[0]!, a: pts[0]!, b: pts[1]! };
  let half = total / 2;
  for (let i = 0; i < segs.length; i++) {
    if (half <= segs[i]! || i === segs.length - 1) {
      const t = segs[i]! === 0 ? 0 : half / segs[i]!;
      const a = pts[i]!;
      const b = pts[i + 1]!;
      return { at: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], a, b };
    }
    half -= segs[i]!;
  }
  return { at: pts[0]!, a: pts[0]!, b: pts[1]! };
}

/** Un plot édité (même id) a-t-il changé de position, nom, couleur ou figuré ? */
function plotChanged(a: WaypointOrder, b: WaypointOrder): boolean {
  return a.lat !== b.lat || a.lng !== b.lng || a.name !== b.name || a.color !== b.color || a.sidc !== b.sidc;
}

/** Icône d'un point nommé : rond coloré (cliquable, 16×16) + libellé à droite. */
function pointIcon(color: string, name: string): L.DivIcon {
  return L.divIcon({
    className: 'tq-point',
    html: `<i class="pt-dot" style="background:${color}"></i><b class="pt-name">${escapeHtml(name)}</b>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

type Rendered =
  | {
      kind: 'graphic';
      graphic: GraphicOrder;
      /** Polyligne (liseré/flèche) ou polygone (box). */
      line: L.Polyline | L.Polygon;
      /** Pointe de flèche, recalculée à chaque zoom (géométrie en pixels). */
      head: L.Polyline | null;
      /** Étiquette posée à un bout de la ligne (ancrée en géographique). */
      label: L.Marker | null;
      /** Figuré d'échelon au centre de la ligne (ancré en géographique). */
      echelon: L.Marker | null;
      /** Couches d'un figuré de mission (tracés + étiquettes). */
      extra: L.Layer[] | null;
    }
  | { kind: 'plot'; marker: L.Marker; w: WaypointOrder };

/** Glyphes d'échelon (limite inter-unités), colorés via `currentColor`. */
const ECHELON_GLYPH: Record<LineEchelon, string> = {
  section: '<i class="ech-dot"></i><i class="ech-dot"></i><i class="ech-dot"></i>',
  company: '<i class="ech-bar"></i>',
  battalion: '<i class="ech-bar"></i><i class="ech-bar"></i>',
};

export interface OrdersLayerCallbacks {
  /** Peut-on supprimer cet élément ? (chef ou auteur) */
  canDelete: (authorId: string) => boolean;
  onDelete: (orderId: string) => void;
  /** Rééditer un plot (ENI / point nommé) : rouvre le menu prérempli. */
  onEdit: (w: WaypointOrder) => void;
  authorName: (authorId: string) => string;
  /** Ma position courante, pour afficher la distance jusqu'à un plot. */
  selfLatLng: () => [number, number] | null;
  /** Vrai pendant une esquisse : ne pas ouvrir de popup sous le doigt. */
  isSketching: () => boolean;
}

export class OrdersLayer {
  private readonly rendered = new Map<string, Rendered>();

  constructor(
    private readonly map: L.Map,
    private readonly cb: OrdersLayerCallbacks,
  ) {
    map.on('zoomend', () => this.redrawHeads());
  }

  sync(orders: Map<string, OrderMessage>): void {
    const graphics = new Map(visibleGraphics(orders).map((g) => [g.id, g]));
    const plots = new Map(visibleWaypoints(orders).map((w) => [w.id, w]));
    for (const [id, r] of this.rendered) {
      if (!graphics.has(id) && !plots.has(id)) {
        this.removeRendered(r);
        this.rendered.delete(id);
      }
    }
    for (const g of graphics.values()) {
      if (!this.rendered.has(g.id)) this.renderGraphic(g);
    }
    for (const w of plots.values()) {
      const cur = this.rendered.get(w.id);
      // Nouveau plot, ou plot édité (même id, contenu changé) → (re)dessiner.
      if (!cur) {
        this.renderPlot(w);
      } else if (cur.kind === 'plot' && plotChanged(cur.w, w)) {
        this.removeRendered(cur);
        this.renderPlot(w);
      }
    }
  }

  clear(): void {
    for (const r of this.rendered.values()) this.removeRendered(r);
    this.rendered.clear();
  }

  private removeRendered(r: Rendered): void {
    if (r.kind === 'graphic') {
      r.line.remove();
      r.head?.remove();
      r.label?.remove();
      r.echelon?.remove();
      for (const l of r.extra ?? []) l.remove();
    } else {
      r.marker.remove();
    }
  }

  private renderGraphic(g: GraphicOrder): void {
    // Ordre relayé = non fiable : on assainit la couleur (injectée dans des
    // attributs style) avant tout rendu.
    const color = safeColor(g.style.color) ?? DEFAULT_COLOR;
    const weight = g.style.weight ?? 4;
    // Figuré de mission : le dessin (tracés + étiquettes) vient du catalogue ;
    // l'axe tracé par l'auteur devient une ligne invisible mais large, cible
    // de tap commode. Id inconnu (client plus récent ?) → ligne simple.
    if (g.style.mission) {
      const extra = renderMission(this.map, g.style.mission, g.latlngs, color, weight);
      if (extra.length) {
        const line = L.polyline(g.latlngs, { color, weight: 22, opacity: 0 }).addTo(this.map);
        const onClick = (e: L.LeafletMouseEvent): void => {
          if (this.cb.isSketching()) return;
          L.DomEvent.stop(e);
          this.openGraphicPopup(g, e.latlng);
        };
        line.on('click', onClick);
        for (const l of extra) {
          l.addTo(this.map);
          if (l instanceof L.Path) l.on('click', onClick);
        }
        this.rendered.set(g.id, { kind: 'graphic', graphic: g, line, head: null, label: null, echelon: null, extra });
        return;
      }
    }
    // Une box est une polyligne fermée, remplie en semi-transparent.
    const line = g.style.polygon
      ? L.polygon(g.latlngs, { color, weight, fillColor: color, fillOpacity: 0.18, opacity: 0.9 }).addTo(this.map)
      : L.polyline(g.latlngs, { color, weight, dashArray: g.style.dashArray, opacity: 0.9 }).addTo(this.map);
    line.on('click', (e) => {
      if (this.cb.isSketching()) return;
      L.DomEvent.stop(e);
      this.openGraphicPopup(g, e.latlng);
    });
    const r: Rendered = { kind: 'graphic', graphic: g, line, head: null, label: null, echelon: null, extra: null };
    // Flèche et figuré d'échelon ne concernent que les lignes ouvertes.
    if (g.style.arrow && !g.style.polygon) r.head = this.makeHead(g, color);
    if (g.style.label) {
      r.label = g.style.polygon
        ? this.makeCenteredLabel(line.getCenter(), g.style.label, color)
        : this.makeLabel(g, color);
    }
    if (g.style.echelon && !g.style.polygon) r.echelon = this.makeEchelon(g, color);
    this.rendered.set(g.id, r);
  }

  /** Nom de la ligne, posé à son dernier sommet (flottant en haut à droite). */
  private makeLabel(g: GraphicOrder, color: string): L.Marker {
    const end = g.latlngs[g.latlngs.length - 1]!;
    const icon = L.divIcon({
      className: 'tq-line-label',
      html: `<span style="color:${color}">${escapeHtml(g.style.label!)}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    return L.marker(end, { icon, interactive: false, zIndexOffset: 400 }).addTo(this.map);
  }

  /** Nom centré sur un point (utilisé au centre d'une box). */
  private makeCenteredLabel(at: L.LatLng, text: string, color: string): L.Marker {
    const icon = L.divIcon({
      className: 'tq-box-label',
      html: `<span style="color:${color}">${escapeHtml(text)}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    return L.marker(at, { icon, interactive: false, zIndexOffset: 400 }).addTo(this.map);
  }

  /**
   * Figuré d'échelon (points/barres) au milieu de la ligne, orienté selon
   * celle-ci : le glyphe est aligné sur la direction de la ligne, donc les
   * points la suivent et les barres la traversent (perpendiculaires).
   */
  private makeEchelon(g: GraphicOrder, color: string): L.Marker | null {
    const mid = midpointAlong(g.latlngs);
    if (!mid) return null;
    const angle = this.segmentAngleDeg(mid.a, mid.b);
    const transform = `translate(-50%, -50%) rotate(${angle}deg)`;
    const icon = L.divIcon({
      className: 'tq-echelon',
      html: `<span class="ech" style="color:${color};transform:${transform}">${ECHELON_GLYPH[g.style.echelon!]}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    return L.marker(mid.at, { icon, interactive: false, zIndexOffset: 400 }).addTo(this.map);
  }

  /**
   * Angle à l'écran (degrés, sens horaire) du segment a→b. La projection
   * Mercator étant conforme, cet angle est invariant au zoom : inutile de le
   * recalculer (contrairement à la pointe de flèche, dimensionnée en pixels).
   * Ramené dans [-90, 90] pour que le glyphe ne se retourne pas.
   */
  private segmentAngleDeg(a: [number, number], b: [number, number]): number {
    const pa = this.map.latLngToLayerPoint(L.latLng(a[0], a[1]));
    const pb = this.map.latLngToLayerPoint(L.latLng(b[0], b[1]));
    let deg = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
    if (deg > 90) deg -= 180;
    if (deg < -90) deg += 180;
    return deg;
  }

  private renderPlot(w: WaypointOrder): void {
    // Charge utile non fiable (relais opaque) : couleur assainie, SIDC validé
    // avant d'être passé à milsymbol.
    const color = w.color != null ? (safeColor(w.color) ?? DEFAULT_COLOR) : null;
    const sidc = w.sidc && SIDC_REGEX.test(w.sidc) ? w.sidc : HOSTILE_SIDC;
    const marker = L.marker([w.lat, w.lng], {
      icon: color ? pointIcon(color, w.name) : getPlotIcon(sidc, w.name),
      zIndexOffset: 500,
    }).addTo(this.map);
    marker.on('click', (e) => {
      if (this.cb.isSketching()) return;
      L.DomEvent.stop(e);
      const self = this.cb.selfLatLng();
      const dist = self
        ? `<span class="order-dist">à ${formatDistance(
            distanceM({ lat: self[0], lng: self[1] }, { lat: w.lat, lng: w.lng }),
          )} de vous</span>`
        : '';
      const title = `<b>${escapeHtml(w.name)}</b>` + coordsWithAltitudeHtml(w.lat, w.lng) + dist;
      this.openPopup(w.id, w.authorId, title, e.latlng, () => this.cb.onEdit(w));
    });
    this.rendered.set(w.id, { kind: 'plot', marker, w });
  }

  /** Pointe en bout de ligne. Taille constante à l'écran (d'où le recalcul
   *  au zoom), mais direction calculée en géographique : la projection en
   *  pixels donne un angle de bruit quand la carte est très dézoomée ou que
   *  les derniers points sont confondus. */
  private makeHead(g: GraphicOrder, color: string): L.Polyline | null {
    const n = g.latlngs.length;
    if (n < 2) return null;
    const tipLL = g.latlngs[n - 1]!;
    // Dernier point réellement distinct (un double tap crée des doublons).
    let i = n - 2;
    while (i > 0 && isSamePoint(g.latlngs[i]!, tipLL)) i--;
    const prevLL = g.latlngs[i]!;
    if (isSamePoint(prevLL, tipLL)) return null;

    // Cap en espace écran (x = est, y = sud) via équirectangulaire locale.
    const dx = (tipLL[1] - prevLL[1]) * Math.cos((tipLL[0] * Math.PI) / 180);
    const dy = tipLL[0] - prevLL[0];
    const ang = Math.atan2(-dy, dx);
    const tip = this.map.latLngToLayerPoint(L.latLng(...tipLL));
    const wing = (side: number) =>
      this.map.layerPointToLatLng(
        L.point(
          tip.x - HEAD_LENGTH_PX * Math.cos(ang + side * HEAD_SPREAD_RAD),
          tip.y - HEAD_LENGTH_PX * Math.sin(ang + side * HEAD_SPREAD_RAD),
        ),
      );
    return L.polyline([wing(-1), this.map.layerPointToLatLng(tip), wing(1)], {
      color,
      weight: g.style.weight ?? 4,
      opacity: 0.9,
      interactive: false,
    }).addTo(this.map);
  }

  private redrawHeads(): void {
    for (const r of this.rendered.values()) {
      if (r.kind !== 'graphic' || !r.graphic.style.arrow) continue;
      r.head?.remove();
      r.head = this.makeHead(r.graphic, safeColor(r.graphic.style.color) ?? DEFAULT_COLOR);
    }
  }

  private openGraphicPopup(g: GraphicOrder, at: L.LatLng): void {
    // Figuré de mission : nom doctrinal, pas de longueur (l'axe n'en est pas une).
    const m = g.style.mission ? missionDef(g.style.mission) : undefined;
    if (m) {
      this.openPopup(g.id, g.authorId, `<b>${escapeHtml(`${m.name} (${m.abbr})`)}</b>`, at);
      return;
    }
    const fallback = g.style.polygon ? 'Box' : g.style.arrow ? 'Flèche' : 'Liseré';
    const name = g.style.label ? escapeHtml(g.style.label) : fallback;
    // Box : le périmètre n'apporte rien — on n'affiche que le nom.
    if (g.style.polygon) {
      this.openPopup(g.id, g.authorId, `<b>${name}</b>`, at);
      return;
    }
    let len = 0;
    for (let i = 1; i < g.latlngs.length; i++) {
      len += distanceM(
        { lat: g.latlngs[i - 1]![0], lng: g.latlngs[i - 1]![1] },
        { lat: g.latlngs[i]![0], lng: g.latlngs[i]![1] },
      );
    }
    const title = `<b>${name}</b> — ${formatDistance(len)}`;
    this.openPopup(g.id, g.authorId, title, at);
  }

  private openPopup(
    orderId: string,
    authorId: string,
    titleHtml: string,
    at: L.LatLng,
    onEdit?: () => void,
  ): void {
    const div = document.createElement('div');
    div.className = 'order-popup';
    div.innerHTML =
      `${titleHtml}<br>` +
      `<span class="order-author">par ${escapeHtml(this.cb.authorName(authorId))}</span>`;
    if (this.cb.canDelete(authorId)) {
      const actions = document.createElement('div');
      actions.className = 'order-actions';
      if (onEdit) {
        const edit = document.createElement('button');
        edit.className = 'btn';
        edit.textContent = 'Modifier';
        edit.addEventListener('click', () => {
          this.map.closePopup();
          onEdit();
        });
        actions.appendChild(edit);
      }
      const del = document.createElement('button');
      del.className = 'btn order-delete';
      del.textContent = 'Supprimer';
      del.addEventListener('click', () => {
        this.map.closePopup();
        this.cb.onDelete(orderId);
      });
      actions.appendChild(del);
      div.appendChild(actions);
    }
    hydrateAltitudes(div); // remplit l'altitude des coordonnées présentes
    L.popup({ closeButton: true, className: 'tq-popup' }).setLatLng(at).setContent(div).openOn(this.map);
  }
}
