// Le plugin leaflet-rotate n'a pas de types : on déclare le module et on
// augmente L.Map / L.MapOptions avec l'API de rotation qu'on utilise.
declare module 'leaflet-rotate';

import 'leaflet';

declare module 'leaflet' {
  interface Map {
    /** Tourne la carte de `theta` degrés (sens horaire). */
    setBearing(theta: number): void;
    getBearing(): number;
  }
  interface MapOptions {
    /** Active la rotation (crée le rotatePane). */
    rotate?: boolean;
    /** Bouton boussole intégré du plugin (on fournit le nôtre). */
    rotateControl?: boolean;
    /** Rotation à deux doigts. */
    touchRotate?: boolean;
    /** Rotation desktop (Shift + glisser). */
    shiftKeyRotate?: boolean;
    bearing?: number;
  }
}
