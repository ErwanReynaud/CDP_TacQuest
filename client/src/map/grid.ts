import L from 'leaflet';
import { fromUtm, toUtm, utmZone } from '../coords';
import { DEFAULT_LAYER, isSatelliteBase } from './layers';

// Quadrillage kilométrique de la carte : la grille métrique UTM, celle des
// coordonnées MGRS/UTM affichées (en format « Géo » on garde la même grille —
// les carreaux font toujours 1 km). Traits pleins de 3 px, sans remplissage :
// gris blanc sur fond imagerie, noirs sur Plan/Topo. Les kilomètres sont
// étiquetés à partir du carré entièrement visible le plus en bas à gauche :
// sa colonne porte les ordonnées (en bas au milieu de chaque carré), sa ligne
// porte les abscisses (à gauche au milieu de chaque carré). Purement local,
// désactivable depuis le tiroir.

const GRID_KEY = 'tq-grid';
const KM = 1000;
/** Espacement minimal à l'écran (px) pour dessiner la grille : en dessous,
 *  traits et étiquettes noieraient la carte. */
const MIN_SPACING_PX = 75;
const SAT_COLOR = '#e8e8e8';
const PLAN_COLOR = '#000000';

let enabled = ((): boolean => {
  try {
    return localStorage.getItem(GRID_KEY) !== '0';
  } catch {
    return true;
  }
})();

/** État persisté de l'option (lisible avant la création de la carte). */
export function gridEnabled(): boolean {
  return enabled;
}

/** Kilomètre « principal » MGRS/UTM : 2 chiffres dans le carré de 100 km. */
function kmLabel(meters: number): string {
  return String(Math.round(meters / KM) % 100).padStart(2, '0');
}

export class CoordGrid {
  private drawn: L.Layer[] = [];
  private satellite = isSatelliteBase(DEFAULT_LAYER);
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly map: L.Map) {
    // Pane dédié : au-dessus des tuiles (200) mais sous les figurés (400),
    // et transparent aux taps. Impérativement DANS le rotatePane de
    // leaflet-rotate (qui contient tuiles et overlays, z=400) : un pane
    // frère passerait sous tout le bloc tuiles et ne tournerait pas en
    // mode boussole.
    const pane = map.createPane('tq-grid', map.getPane('rotatePane'));
    pane.style.zIndex = '350';
    pane.style.pointerEvents = 'none';
    map.on('moveend zoomend', () => this.redraw());
    map.on('baselayerchange', (e) => {
      this.satellite = isSatelliteBase((e as L.LayersControlEvent).name);
      this.redraw();
    });
    // Rotation boussole : le cadrage déborde du tracé initial — redessiner,
    // débouncé (l'événement arrive en continu pendant la rotation).
    map.on('rotate', () => {
      if (this.rotateTimer) clearTimeout(this.rotateTimer);
      this.rotateTimer = setTimeout(() => this.redraw(), 300);
    });
    this.redraw();
  }

  setEnabled(on: boolean): void {
    if (on === enabled) return;
    enabled = on;
    try {
      localStorage.setItem(GRID_KEY, on ? '1' : '0');
    } catch {
      /* quota : l'état reste au moins en mémoire */
    }
    this.redraw();
  }

  private clear(): void {
    for (const l of this.drawn) l.remove();
    this.drawn = [];
  }

  private redraw(): void {
    this.clear();
    if (!enabled) return;
    const c = this.map.getCenter();
    // Mètres par pixel au centre (Web Mercator).
    const mpp =
      (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** (this.map.getZoom() + 8);
    if (KM / mpp < MIN_SPACING_PX) return; // trop dézoomé : pas de grille

    // Tout est projeté dans la zone du centre : grille continue même à
    // cheval sur un bord de zone UTM.
    const zone = utmZone(c.lat, c.lng);
    const southern = c.lat < 0;
    const utmEnvelope = (b: L.LatLngBounds): { e0: number; e1: number; n0: number; n1: number } => {
      const corners = [b.getSouthWest(), b.getSouthEast(), b.getNorthWest(), b.getNorthEast()].map(
        (p) => toUtm(p.lat, p.lng, zone),
      );
      return {
        e0: Math.min(...corners.map((u) => u.easting)),
        e1: Math.max(...corners.map((u) => u.easting)),
        n0: Math.min(...corners.map((u) => u.northing)),
        n1: Math.max(...corners.map((u) => u.northing)),
      };
    };
    const at = (e: number, n: number): [number, number] => {
      const p = fromUtm(zone, e, n, southern);
      return [p.lat, p.lng];
    };

    // Lignes : sur le cadrage élargi (marge pour le pan), échantillonnées
    // (les lignes de grille UTM ne sont pas parfaitement droites à l'écran :
    // convergence des méridiens).
    const pad = utmEnvelope(this.map.getBounds().pad(0.25));
    const eMin = Math.floor(pad.e0 / KM) * KM;
    const nMin = Math.floor(pad.n0 / KM) * KM;
    if ((pad.e1 - eMin) / KM + (pad.n1 - nMin) / KM > 400) return; // garde-fou
    const samples = (from: number, to: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i <= 8; i++) out.push(from + ((to - from) * i) / 8);
      return out;
    };
    const color = this.satellite ? SAT_COLOR : PLAN_COLOR;
    for (let e = eMin; e <= pad.e1; e += KM) {
      this.addLine(samples(nMin, pad.n1).map((n) => at(e, n)), color);
    }
    for (let n = nMin; n <= pad.n1; n += KM) {
      this.addLine(samples(eMin, pad.e1).map((e) => at(e, n)), color);
    }

    // Étiquettes : ancrées au carré du centre de l'écran. Sa colonne porte
    // les ordonnées, sa ligne les abscisses — avec un carré de débord de
    // chaque côté, pour qu'un carré partiellement visible garde son numéro.
    const vis = utmEnvelope(this.map.getBounds());
    const center = toUtm(c.lat, c.lng, zone);
    const eC = Math.floor(center.easting / KM) * KM;
    const nC = Math.floor(center.northing / KM) * KM;
    for (let n = Math.floor(vis.n0 / KM) * KM; n <= vis.n1; n += KM) {
      // Ordonnée du carré (bord bas), posée en bas au milieu du carré.
      this.addLabel(at(eC + KM / 2, n), kmLabel(n), 'ord');
    }
    for (let e = Math.floor(vis.e0 / KM) * KM; e <= vis.e1; e += KM) {
      // Abscisse du carré (bord gauche), posée à gauche au milieu du carré.
      this.addLabel(at(e, nC + KM / 2), kmLabel(e), 'abs');
    }
  }

  private addLine(latlngs: [number, number][], color: string): void {
    this.drawn.push(
      L.polyline(latlngs, {
        pane: 'tq-grid',
        interactive: false,
        color,
        weight: 2,
        opacity: 1,
      }).addTo(this.map),
    );
  }

  private addLabel(latlng: [number, number], text: string, kind: 'ord' | 'abs'): void {
    // Marker du pane par défaut : reste droit en mode boussole (leaflet-rotate
    // contre-tourne les markers), au-dessus des lignes de la grille.
    this.drawn.push(
      L.marker(latlng, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: `tq-grid-label tq-grid-${kind} ${this.satellite ? 'sat' : 'plan'}`,
          html: `<span>${text}</span>`,
          iconSize: [0, 0],
        }),
      }).addTo(this.map),
    );
  }
}
