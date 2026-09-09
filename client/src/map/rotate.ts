// leaflet-rotate est un plugin UMD qui s'accroche au `L` global (il ne fait
// pas `require('leaflet')`). En ESM/Vite ce global n'existe pas : on l'expose
// ici. Ce module DOIT être importé juste AVANT `import 'leaflet-rotate'`
// (l'ordre des imports ESM garantit cette évaluation préalable).
import L from 'leaflet';

(globalThis as unknown as { L: typeof L }).L = L;
