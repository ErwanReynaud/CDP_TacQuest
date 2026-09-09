import L from 'leaflet';

// Les hostnames de ces couches sont aussi listés dans public/sw.js
// (cache hors-ligne des tuiles) — garder les deux synchronisés.

// Clé de la couche affichée par défaut (voir aussi mapView.initLeaflet).
// Convention de nommage : provenance dans le nom, préfixe « Sat » pour
// l'imagerie (isSatelliteBase s'appuie dessus).
export const DEFAULT_LAYER = 'Sat IGN';

/** Fond imagerie (sombre) ? Sert au quadrillage pour choisir sa couleur. */
export function isSatelliteBase(name: string): boolean {
  return name.startsWith('Sat');
}

// Géoplateforme IGN : flux WMTS ouverts, sans clé (ortho BD ORTHO 20 cm et
// Plan IGN v2). Couverture France + DOM uniquement — l'Esri mondial reste
// disponible en secours. SCAN 25 écarté : licence payante (clé privée).
function ignWmts(layer: string, format: string, maxZoom: number): L.TileLayer {
  return L.tileLayer(
    'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
      `&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM` +
      '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}' +
      `&FORMAT=${format}`,
    { maxZoom, attribution: '© <a href="https://www.ign.fr">IGN</a>' },
  );
}

export function createBaseLayers(): Record<string, L.Layer> {
  // Mentions légales volontairement concises (cf. CSS .leaflet-control-attribution).
  const ignOrtho = ignWmts('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg', 19);
  const esriImagery = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: '© <a href="https://www.esri.com">Esri</a>' },
  );
  // Surcouche transparente (routes, voies, chemins) posée sur l'imagerie : rend
  // visibles les axes masqués par la canopée forestière.
  const transportation = () =>
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19 },
    );
  // SCAN 25 (carte topo IGN 1:25 000) : absent du WMTS ouvert — servi par
  // l'endpoint « privé » de la Géoplateforme avec la clé partagée historique
  // `ign_scan_ws` (celle des tutoriels IGN ; pourrait être révoquée un jour).
  // Pyramide native jusqu'au z16, étirée au-delà par maxNativeZoom.
  const scan25 = L.tileLayer(
    'https://data.geopf.fr/private/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
      '&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.SCAN25TOUR&STYLE=normal&TILEMATRIXSET=PM' +
      '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg&apikey=ign_scan_ws',
    { maxZoom: 19, maxNativeZoom: 16, attribution: '© <a href="https://www.ign.fr">IGN</a>' },
  );
  return {
    // Ortho IGN 20 cm (France) + surcouche des routes/chemins.
    'Sat IGN': L.layerGroup([ignOrtho, transportation()]),
    // Secours mondial (hors couverture IGN) : imagerie Esri + mêmes routes.
    'Sat Esri': L.layerGroup([esriImagery, transportation()]),
    // Carte topo 1:25 000 (la « carte IGN 25 » de randonnée / TOPO 25).
    'IGN 25': scan25,
    // Plan IGN v2 : nettement plus riche et lisible que le rendu OSM brut
    // (chemins, végétation, bâti, toponymie militaire-compatible).
    'Plan IGN': ignWmts('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png', 19),
    'Topo OSM': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> · OSM',
    }),
  };
}
