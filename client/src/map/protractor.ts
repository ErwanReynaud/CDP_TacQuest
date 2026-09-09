import L from 'leaflet';

// Rapporteur (« cercle trigo ») centré sur le réticule (centre écran) : anneau
// gradué en degrés (extérieur) et en millièmes (intérieur), 0 = nord. On relève
// l'azimut du réticule vers un point choisi (tap sur la carte).
//
// Alignement nord — y compris en mode boussole : l'anneau est un overlay
// écran-fixe qu'on fait tourner de `map.getBearing()` (la même rotation que le
// pane de leaflet-rotate), donc son nord suit le nord de la carte. L'azimut
// affiché est calculé sur les coordonnées (bearing géographique), donc juste
// quel que soit l'affichage ; la ligne réticule→cible est une polyligne Leaflet
// (dans le pane carte) qui tourne d'elle-même avec la carte.

const MIL_PER_DEG = 6400 / 360;

/** Azimut initial (0 = nord, sens horaire) de a vers b, en degrés [0,360). */
function bearingDeg(a: L.LatLng, b: L.LatLng): number {
  const f1 = (a.lat * Math.PI) / 180;
  const f2 = (b.lat * Math.PI) / 180;
  const dl = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Anneau SVG (viewBox 0-420, centre 210,210), nord en haut avant rotation. */
function buildRingSvg(): string {
  const cx = 210;
  const cy = 210;
  const parts: string[] = [
    `<circle cx="${cx}" cy="${cy}" r="205" class="pr-ring"/>`,
    `<circle cx="${cx}" cy="${cy}" r="150" class="pr-ring"/>`,
  ];
  const pt = (ang: number, r: number): [number, number] => {
    const a = (ang * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };
  const tick = (ang: number, r1: number, r2: number, cls: string): string => {
    const [x1, y1] = pt(ang, r1);
    const [x2, y2] = pt(ang, r2);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="${cls}"/>`;
  };
  const label = (ang: number, r: number, text: string, cls: string): string => {
    const [x, y] = pt(ang, r);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}">${text}</text>`;
  };

  // Degrés (anneau extérieur) : trait tous les 5°, plus long tous les 30°.
  for (let d = 0; d < 360; d += 5) {
    const major = d % 30 === 0;
    const r2 = major ? 185 : d % 10 === 0 ? 191 : 197;
    parts.push(tick(d, 205, r2, d === 0 ? 'pr-north' : major ? 'pr-major' : 'pr-minor'));
  }
  for (let d = 0; d < 360; d += 30) {
    parts.push(label(d, 173, d === 0 ? 'N' : String(d), d === 0 ? 'pr-deg-label pr-n' : 'pr-deg-label'));
  }

  // Millièmes (anneau intérieur) : trait tous les 100 ‰, plus long tous les 800.
  for (let m = 0; m < 6400; m += 100) {
    const ang = (m / 6400) * 360;
    const major = m % 800 === 0;
    const r2 = major ? 134 : m % 400 === 0 ? 140 : 144;
    parts.push(tick(ang, 150, r2, major ? 'pr-major' : 'pr-minor'));
  }
  for (let m = 0; m < 6400; m += 800) {
    parts.push(label((m / 6400) * 360, 126, String(m), 'pr-mil-label'));
  }

  return `<svg viewBox="0 0 420 420" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}

export class Protractor {
  private active = false;
  private target: L.LatLng | null = null;
  private line: L.Polyline | null = null;
  private endDot: L.CircleMarker | null = null;
  private readonly onMapClick = (e: L.LeafletMouseEvent): void => this.setTarget(e.latlng);
  private readonly onMapMove = (): void => this.update();

  constructor(
    private readonly map: L.Map,
    private readonly ring: HTMLElement,
    private readonly readout: HTMLElement,
  ) {
    ring.innerHTML = buildRingSvg();
  }

  /** Bascule l'outil ; renvoie l'état actif résultant. */
  toggle(): boolean {
    if (this.active) this.disable();
    else this.enable();
    return this.active;
  }

  enable(): void {
    if (this.active) return;
    this.active = true;
    this.ring.hidden = false;
    this.readout.hidden = false;
    if (!this.target) this.readout.textContent = 'Touchez la carte pour relever un azimut';
    this.map.on('click', this.onMapClick);
    this.map.on('move zoom rotate', this.onMapMove);
    this.update();
  }

  disable(): void {
    if (!this.active) return;
    this.active = false;
    this.ring.hidden = true;
    this.readout.hidden = true;
    this.map.off('click', this.onMapClick);
    this.map.off('move zoom rotate', this.onMapMove);
    this.line?.remove();
    this.endDot?.remove();
    this.line = null;
    this.endDot = null;
    this.target = null;
  }

  /** Réaligne l'anneau et rafraîchit ligne + azimut (appelé aussi par la boussole). */
  update(): void {
    if (!this.active) return;
    const bearing = this.map.getBearing?.() ?? 0;
    this.ring.style.transform = `translate(-50%, -50%) rotate(${bearing}deg)`;
    if (!this.target) return;
    const c = this.map.getCenter();
    this.line?.setLatLngs([c, this.target]);
    const az = bearingDeg(c, this.target);
    this.readout.textContent = `${Math.round(az)}° · ${Math.round(az * MIL_PER_DEG)} ‰`;
  }

  private setTarget(latlng: L.LatLng): void {
    this.target = latlng;
    if (!this.line) {
      this.line = L.polyline([this.map.getCenter(), latlng], {
        color: '#0033ff',
        weight: 2,
        dashArray: '6 5',
        interactive: false,
      }).addTo(this.map);
    }
    // Point précis marquant l'extrémité visée.
    if (!this.endDot) {
      this.endDot = L.circleMarker(latlng, {
        radius: 4,
        color: '#fff',
        weight: 1.5,
        fillColor: '#0033ff',
        fillOpacity: 1,
        interactive: false,
      }).addTo(this.map);
    } else {
      this.endDot.setLatLng(latlng);
    }
    this.update();
  }
}
