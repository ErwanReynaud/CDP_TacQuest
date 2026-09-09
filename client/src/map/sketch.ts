import L from 'leaflet';
import { distanceM } from '../geo';

export interface SketchOptions {
  color: string;
  /**
   * Appelé à chaque modification (sommet posé/retiré, carte déplacée).
   * `previewM` inclut le segment élastique dernier sommet → réticule.
   */
  onChange: (points: L.LatLng[], previewM: number) => void;
}

/**
 * Esquisse pilotée par le réticule central : les sommets se posent au centre
 * de la carte (précision), un segment d'aperçu suit le réticule en continu.
 * Sert à la fois à l'outil de mesure et au tracé des graphiques.
 */
export class PolylineSketch {
  private readonly points: L.LatLng[] = [];
  private readonly line: L.Polyline;
  private readonly preview: L.Polyline;
  private readonly dots: L.CircleMarker[] = [];

  constructor(
    private readonly map: L.Map,
    private readonly opts: SketchOptions,
  ) {
    this.line = L.polyline([], {
      color: opts.color,
      weight: 3,
      dashArray: '6 6',
      interactive: false,
    }).addTo(map);
    this.preview = L.polyline([], {
      color: opts.color,
      weight: 2,
      dashArray: '2 8',
      opacity: 0.75,
      interactive: false,
    }).addTo(map);
    map.on('move', this.onMove);
  }

  private onMove = (): void => {
    this.updatePreview();
    this.notify();
  };

  /** Pose un sommet au centre de la carte (sous le réticule). */
  addVertexAtCenter(): void {
    this.addVertex(this.map.getCenter());
  }

  addVertex(latlng: L.LatLng): void {
    this.points.push(latlng);
    this.line.setLatLngs(this.points);
    const dot = L.circleMarker(latlng, {
      radius: 5,
      color: this.opts.color,
      fillColor: this.opts.color,
      fillOpacity: 1,
      interactive: false,
    }).addTo(this.map);
    this.dots.push(dot);
    this.updatePreview();
    this.notify();
  }

  undo(): void {
    if (this.points.length === 0) return;
    this.points.pop();
    this.dots.pop()?.remove();
    this.line.setLatLngs(this.points);
    this.updatePreview();
    this.notify();
  }

  setColor(color: string): void {
    this.opts.color = color;
    this.line.setStyle({ color });
    this.preview.setStyle({ color });
    for (const dot of this.dots) dot.setStyle({ color, fillColor: color });
  }

  getPoints(): L.LatLng[] {
    return [...this.points];
  }

  /**
   * Sommets finaux : les points posés, plus la position courante du réticule
   * si elle est distincte du dernier sommet — valider sans « + Pt » suffit
   * donc pour une flèche origine → réticule.
   */
  getFinalPoints(): L.LatLng[] {
    const pts = this.getPoints();
    const center = this.map.getCenter();
    const last = pts[pts.length - 1];
    if (!last || distanceM(last, center) > 1) pts.push(center);
    return pts;
  }

  /**
   * Fige l'esquisse : commet le point sous le réticule comme dernier sommet,
   * stoppe le suivi du réticule et efface le segment d'aperçu. Le tracé reste
   * affiché tel quel (utile pour garder la ligne visible sous un menu).
   */
  freeze(): L.LatLng[] {
    this.map.off('move', this.onMove);
    const pts = this.getFinalPoints();
    this.points.length = 0;
    this.points.push(...pts);
    this.line.setLatLngs(this.points);
    this.preview.setLatLngs([]);
    return [...this.points];
  }

  /** Longueur posée + segment d'aperçu vers le réticule. */
  previewLengthM(): number {
    let total = 0;
    for (let i = 1; i < this.points.length; i++) {
      total += distanceM(this.points[i - 1]!, this.points[i]!);
    }
    const last = this.points[this.points.length - 1];
    if (last) total += distanceM(last, this.map.getCenter());
    return total;
  }

  destroy(): void {
    this.map.off('move', this.onMove);
    this.line.remove();
    this.preview.remove();
    for (const dot of this.dots) dot.remove();
  }

  private updatePreview(): void {
    const last = this.points[this.points.length - 1];
    this.preview.setLatLngs(last ? [last, this.map.getCenter()] : []);
  }

  private notify(): void {
    this.opts.onChange(this.getPoints(), this.previewLengthM());
  }
}
