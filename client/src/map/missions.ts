import L from 'leaflet';
import { escapeHtml } from '../util';
import { missionDef } from './missionCatalog';

// Rendu Leaflet des figurés de mission (catalogue : missionCatalog.ts).

// --- rendu carte ---

interface Pt {
  x: number;
  y: number;
}

const add = (p: Pt, q: Pt): Pt => ({ x: p.x + q.x, y: p.y + q.y });
const sub = (p: Pt, q: Pt): Pt => ({ x: p.x - q.x, y: p.y - q.y });
const mul = (p: Pt, k: number): Pt => ({ x: p.x * k, y: p.y * k });
const rot = (p: Pt, rad: number): Pt => ({
  x: p.x * Math.cos(rad) - p.y * Math.sin(rad),
  y: p.x * Math.sin(rad) + p.y * Math.cos(rad),
});

/** Zoom de référence des calculs : indépendant de la vue courante (et sans
 *  l'arrondi au pixel de latLngToLayerPoint), la géométrie est stable. */
const REF_ZOOM = 18;

/**
 * Construit les couches Leaflet d'un figuré de mission le long de l'axe tracé
 * (premier → dernier sommet). Les polylignes sont interactives (cible de tap),
 * les étiquettes non. Id inconnu ou axe dégénéré → [] (l'appelant retombe sur
 * une ligne simple).
 */
export interface RenderMissionOpts {
  /** Aperçu pendant l'esquisse : couches non interactives, semi-transparentes. */
  interactive?: boolean;
  opacity?: number;
}

export function renderMission(
  map: L.Map,
  id: string,
  latlngs: [number, number][],
  color: string,
  weight: number,
  opts?: RenderMissionOpts,
): L.Layer[] {
  const def = missionDef(id);
  if (!def || latlngs.length < 2) return [];
  const px = (ll: [number, number]): Pt => map.project(L.latLng(ll[0], ll[1]), REF_ZOOM);
  const a = px(latlngs[0]!);
  // Figuré à deux flèches : la 1re est strictement les points 0–1, la 2de les
  // points 2–fin (tracée séparément). Sinon, l'axe va du premier au dernier.
  const b = px(def.twoArrows ? latlngs[1]! : latlngs[latlngs.length - 1]!);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return [];
  /** Seconde flèche (points 2–fin), si elle a été tracée. */
  const secondArm = (): { from: Pt; to: Pt; dir: Pt } | null => {
    if (!def.twoArrows || latlngs.length < 4) return null;
    const from = px(latlngs[2]!);
    const to = px(latlngs[latlngs.length - 1]!);
    const l = Math.hypot(to.x - from.x, to.y - from.y);
    if (l < 1e-6) return null;
    return { from, to, dir: mul(sub(to, from), 1 / l) };
  };
  const u = mul(sub(b, a), 1 / len); // axe unitaire origine → pointe
  const v: Pt = { x: -u.y, y: u.x }; // normale
  // Taille des décorations (pointes, zigzags, chevrons, hachures) : suit la
  // longueur sur les petits figurés puis croît en racine — une grande flèche
  // garde une pointe sobre au lieu de gonfler proportionnellement.
  const DECO_REF = 250; // px au zoom de référence (~100 m)
  const dlen = len <= DECO_REF ? len : DECO_REF * Math.sqrt(len / DECO_REF);
  const layers: L.Layer[] = [];

  const toLL = (p: Pt): L.LatLng => map.unproject(L.point(p.x, p.y), REF_ZOOM);
  /** Une ou plusieurs polylignes (segments) en une seule couche. */
  const lines = (segs: Pt[][], dash?: string): void => {
    layers.push(
      L.polyline(segs.map((s) => s.map(toLL)), {
        color,
        weight,
        opacity: opts?.opacity ?? 0.95,
        dashArray: dash,
        interactive: opts?.interactive ?? true,
      }),
    );
  };
  const label = (p: Pt, text: string): void => {
    const icon = L.divIcon({
      className: 'tq-mission-label',
      html: `<span style="color:${color}">${escapeHtml(text)}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    layers.push(L.marker(toLL(p), { icon, interactive: false, zIndexOffset: 400 }));
  };
  /** Pointe ouverte en `tip`, orientée selon `dir`, à l'échelle décorative. */
  const head = (tip: Pt, dir: Pt): void => {
    const size = dlen * 0.14;
    const back = mul(dir, -1);
    lines([[add(tip, mul(rot(back, 0.5), size)), tip, add(tip, mul(rot(back, -0.5), size))]]);
  };
  const at = (t: number): Pt => add(a, mul(u, len * t));
  /** Éclair : ligne avec un crochet en Z au milieu (ECL / RECO / COUV / SURV). */
  const zigzag = (from: Pt, to: Pt): Pt[] => {
    const d = sub(to, from);
    const l = Math.hypot(d.x, d.y) || 1;
    const w = mul(d, 1 / l);
    const n: Pt = { x: -w.y, y: w.x };
    const k = Math.min(dlen * 0.1, l * 0.15);
    const m = add(from, mul(w, l / 2));
    const z1 = add(add(m, mul(w, k * 0.5)), mul(n, -k));
    const z2 = add(sub(m, mul(w, k * 0.5)), mul(n, k));
    return [from, z1, z2, to];
  };
  /** Cercle (points échantillonnés) de centre c et rayon r. */
  const circlePts = (c: Pt, r: number, fromDeg = 0, toDeg = 360, stepDeg = 6): Pt[] => {
    const out: Pt[] = [];
    for (let deg = fromDeg; deg <= toDeg; deg += stepDeg) {
      const t = (deg * Math.PI) / 180;
      out.push(add(c, { x: r * Math.cos(t), y: r * Math.sin(t) }));
    }
    return out;
  };
  /** Chevron d'empennage « > » (apex sur `apex`, branches vers l'arrière). */
  const fletch = (apex: Pt): void => {
    const back = mul(u, -dlen * 0.09);
    const side = mul(v, dlen * 0.07);
    lines([[add(add(apex, back), side), apex, add(add(apex, back), mul(side, -1))]]);
  };

  const mid = at(0.5);
  switch (def.id) {
    case 'ecl':
    case 'reco': {
      lines([zigzag(a, b)]);
      head(b, u);
      label(add(mid, mul(v, -dlen * 0.22)), def.abbr);
      break;
    }
    case 'fix': {
      // Ressort à 3 crêtes centré, pointe au bout ; le ressort garde une
      // emprise décorative (il ne s'étire pas sur toute une grande flèche).
      const amp = dlen * 0.12;
      const span = Math.min(len * 0.4, dlen * 0.5);
      const t0 = 0.5 - span / (2 * len);
      const pts: Pt[] = [a, at(t0)];
      const steps = 6;
      for (let j = 1; j <= steps; j++) {
        const p = at(t0 + (span / len) * (j / steps));
        pts.push(j === steps ? p : add(p, mul(v, j % 2 ? -amp : amp)));
      }
      pts.push(b);
      lines([pts]);
      head(b, u);
      break;
    }
    case 'app': {
      // On trace la diagonale du rectangle (aligné nord) qui contient le
      // figuré : largeur = écart est-ouest, profondeur = écart nord-sud,
      // flèches vers le haut ou le bas selon le sens de la diagonale.
      const W = Math.abs(b.x - a.x);
      const H = Math.abs(b.y - a.y);
      if (W < 1e-6 || H < 1e-6) {
        lines([[a, b]]); // diagonale dégénérée : simple trait en attendant
        break;
      }
      const f = Math.sign(b.y - a.y); // sens des flèches (écran : -1 = haut)
      const cx = (a.x + b.x) / 2;
      const rear = f < 0 ? Math.max(a.y, b.y) : Math.min(a.y, b.y);
      const front = rear + f * H;
      const barY = rear + f * H * 0.25;
      const bw = W * 0.375; // demi-barre ; les jambes rejoignent les coins arrière
      const c1: Pt = { x: cx - bw, y: barY };
      const c2: Pt = { x: cx + bw, y: barY };
      const t1: Pt = { x: cx - W * 0.47, y: front };
      const t2: Pt = { x: cx + W * 0.47, y: front };
      lines([
        [c1, c2],
        [c1, { x: cx - W / 2, y: rear }],
        [c2, { x: cx + W / 2, y: rear }],
        [c1, t1],
        [c2, t2],
      ]);
      const n1 = sub(t1, c1);
      const n2 = sub(t2, c2);
      head(t1, mul(n1, 1 / (Math.hypot(n1.x, n1.y) || 1)));
      head(t2, mul(n2, 1 / (Math.hypot(n2.x, n2.y) || 1)));
      break;
    }
    case 'appf':
    case 'sout': {
      // Flèche d'arc (empennage double « ≫ ») — symbole commun APP / SOUT,
      // distingués par leur libellé.
      lines([[a, b]]);
      head(b, u);
      fletch(add(a, mul(u, dlen * 0.09)));
      fletch(add(a, mul(u, dlen * 0.18)));
      label(add(a, mul(v, -dlen * 0.2)), def.abbr);
      break;
    }
    case 'neut':
    case 'det': {
      // Croix de Saint-André sur l'axe, lettre au centre ; NEUT en tireté.
      const arm = len / 2;
      const d1 = rot(u, 0.6);
      const d2 = rot(u, -0.6);
      lines(
        [
          [sub(mid, mul(d1, arm)), add(mid, mul(d1, arm))],
          [sub(mid, mul(d2, arm)), add(mid, mul(d2, arm))],
        ],
        def.id === 'neut' ? '10 10' : undefined,
      );
      label(mid, def.id === 'neut' ? 'N' : 'D');
      break;
    }
    case 'interd': {
      // Deux flèches tracées l'une après l'autre (le X se forme à la main).
      lines([[a, b]]);
      head(b, u);
      const s = secondArm();
      if (s) {
        lines([[s.from, s.to]]);
        head(s.to, s.dir);
      }
      break;
    }
    case 'recu': {
      lines([[a, b]]);
      head(b, u);
      const t = dlen * 0.18;
      lines([[add(mid, mul(v, t)), add(mid, mul(v, -t))]]);
      break;
    }
    case 'def':
    case 'ten': {
      // Flèche circulaire (360°) : cercle ouvert à l'est (angle 0) où
      // s'inscrit la lettre (D défendre / R tenir), pointe tangente à −π
      // (ouest), petits traits orthogonaux partout sauf autour de la lettre.
      const r = len;
      lines([circlePts(a, r, 22, 338, 4)]);
      // Pointe bien marquée, tangente vers le haut ; le trait radial de 180°
      // est omis pour qu'elle ne se confonde pas avec les hachures.
      const tip: Pt = add(a, { x: -r, y: 0 });
      const hs = dlen * 0.2;
      lines([[add(tip, { x: -hs * 0.45, y: hs }), tip, add(tip, { x: hs * 0.45, y: hs })]]);
      const ticks: Pt[][] = [];
      for (let deg = 24; deg <= 336; deg += 12) {
        if (deg === 180) continue;
        const t = (deg * Math.PI) / 180;
        const dir: Pt = { x: Math.cos(t), y: Math.sin(t) };
        ticks.push([add(a, mul(dir, r)), add(a, mul(dir, r + dlen * 0.09))]);
      }
      lines(ticks);
      label(add(a, { x: r, y: 0 }), def.id === 'def' ? 'D' : 'R');
      break;
    }
    case 'boucl': {
      // Cercle à 8 encoches en V pointées vers l'intérieur.
      const pts: Pt[] = [];
      const notchHalf = 8;
      const inner = len - dlen * 0.3;
      for (let k = 0; k < 8; k++) {
        const start = k * 45 + notchHalf;
        const end = (k + 1) * 45 - notchHalf;
        pts.push(...circlePts(a, len, start, end, 5));
        const tIn = (((k + 1) * 45) * Math.PI) / 180;
        pts.push(add(a, { x: inner * Math.cos(tIn), y: inner * Math.sin(tIn) }));
      }
      pts.push(pts[0]!);
      lines([pts]);
      break;
    }
    case 'couv':
    case 'surv': {
      // Deux éclairs tracés l'un après l'autre, lettre au pied de chacun.
      const letter = def.id === 'couv' ? 'C' : 'S';
      const drawArm = (from: Pt, to: Pt, dir: Pt): void => {
        lines([zigzag(from, to)]);
        head(to, dir);
        label(sub(from, mul(dir, dlen * 0.12)), letter);
      };
      drawArm(a, b, u);
      const s = secondArm();
      if (s) drawArm(s.from, s.to, s.dir);
      break;
    }
    case 'semp': {
      // Objectif cerclé (ellipse) à l'ORIGINE du tracé ; la flèche courbe en
      // sort et sa pointe rejoint le deuxième point.
      const rx = dlen * 0.22;
      const ry = dlen * 0.13;
      const ell: Pt[] = [];
      for (let deg = 0; deg <= 360; deg += 10) {
        const t = (deg * Math.PI) / 180;
        ell.push(add(add(a, mul(u, rx * Math.cos(t))), mul(v, ry * Math.sin(t))));
      }
      lines([ell]);
      // Bézier quadratique bord de l'ellipse → b, bombée côté normale.
      const start = add(a, mul(u, rx * 1.15));
      const ctrl = add(mul(add(start, b), 0.5), mul(v, len * 0.25));
      const curve: Pt[] = [];
      for (let j = 0; j <= 16; j++) {
        const t = j / 16;
        const q1 = add(mul(start, (1 - t) * (1 - t)), mul(ctrl, 2 * (1 - t) * t));
        curve.push(add(q1, mul(b, t * t)));
      }
      lines([curve]);
      const tan = sub(curve[16]!, curve[15]!);
      head(b, mul(tan, 1 / (Math.hypot(tan.x, tan.y) || 1)));
      label(add(mul(add(start, b), 0.5), mul(v, dlen * 0.18)), 'S');
      break;
    }
  }
  return layers;
}
