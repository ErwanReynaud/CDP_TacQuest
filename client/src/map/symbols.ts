import L from 'leaflet';
import ms from 'milsymbol';
import { escapeHtml } from '../util';

// Symbologie APP-6 (milsymbol) des plots partagés. Les membres, eux, sont rendus
// en simples points GPS (cf. markers.ts) depuis l'abandon des figurés
// hiérarchiques de commandement côté interface.

/** Losange rouge APP-6 : unité terrestre hostile, sans fonction. */
export const HOSTILE_SIDC = 'SHGP-------';

// Le rendu milsymbol n'est pas gratuit sur CPU faible : mémoïsation.
const plotCache = new Map<string, L.DivIcon>();

/**
 * Icône de plot (positions ennemies). Un `label` non vide est posé en étiquette
 * flottante à droite du symbole (pastille sombre lisible, cohérente avec les
 * autres libellés de l'app) — l'amplificateur natif milsymbol étant minuscule
 * et noir sans fond.
 */
export function getPlotIcon(sidc: string, label = ''): L.DivIcon {
  const key = `${sidc}|${label}`;
  const cached = plotCache.get(key);
  if (cached) return cached;
  // colorMode Dark : remplissages saturés (losange hostile rouge vif).
  const sym = new ms.Symbol(sidc, { size: 22, colorMode: 'Dark' });
  const { width, height } = sym.getSize();
  const anchor = sym.getAnchor();
  const tag = label ? `<b class="tq-plot-label">${escapeHtml(label)}</b>` : '';
  const icon = L.divIcon({
    html: sym.asSVG() + tag,
    className: 'tq-sym tq-plot',
    iconSize: [width, height],
    iconAnchor: [anchor.x, anchor.y],
  });
  plotCache.set(key, icon);
  return icon;
}
