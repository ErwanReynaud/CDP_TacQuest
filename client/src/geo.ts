import { POSITION_INTERVAL_MS } from '@tq/shared/constants';
import type { Position } from '@tq/shared/protocol';
import { dlog } from './debugLog';

/** Distance haversine en mètres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface GeoHandlers {
  /** Appelé à chaque fix retenu pour l'envoi. */
  send: (p: Position) => void;
  /** Appelé à chaque fix (même non envoyé) pour l'affichage local. */
  onFix?: (p: Position) => void;
  onDenied: () => void;
  onUnavailable?: () => void;
}

export interface GeoWatcher {
  stop: () => void;
  /** Dernier fix, pour ré-émission après reconnexion. */
  getLastFix: () => Position | null;
  /** Force l'envoi du dernier fix (après rejoin). */
  resend: () => void;
  /** Force l'acquisition immédiate d'un point frais (haute précision) — geste
   *  utilisateur explicite (bouton « Centrer »). */
  refresh: () => void;
}

/**
 * Échantillonnage périodique basse consommation. Contrairement à un
 * `watchPosition` haute précision (récepteur GPS allumé en continu = principal
 * poste de dépense), on prend un point ponctuel à intervalle fixe, en précision
 * réduite, et on laisse l'OS réutiliser un fix récent (`maximumAge`). Entre deux
 * échantillons, le GPS reste éteint.
 *
 * Un point est pris dès l'arrivée (appel), puis toutes les 30 s. La page doit
 * rester au premier plan : la géoloc écran verrouillé a été abandonnée (les
 * navigateurs mobiles gèlent les timers et le GPS en arrière-plan).
 */
export function startGeolocation(handlers: GeoHandlers): GeoWatcher | null {
  if (!('geolocation' in navigator)) {
    handlers.onDenied();
    return null;
  }

  let lastFix: Position | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // `fresh` = acquisition demandée par l'utilisateur : haute précision, sans
  // réutiliser de point en cache (maximumAge 0). Sinon échantillonnage basse conso.
  const takeFix = (fresh = false): void => {
    dlog('gps', fresh ? 'acquisition (rafraîchissement)…' : 'acquisition…');
    navigator.geolocation.getCurrentPosition(
      (gp) => {
        const p: Position = {
          lat: gp.coords.latitude,
          lng: gp.coords.longitude,
          accuracy: gp.coords.accuracy,
          heading: gp.coords.heading !== null && !Number.isNaN(gp.coords.heading) ? gp.coords.heading : null,
          speed: gp.coords.speed !== null && !Number.isNaN(gp.coords.speed) ? gp.coords.speed : null,
          ts: gp.timestamp,
        };
        const ageS = Math.round((Date.now() - gp.timestamp) / 1000);
        dlog('gps', `OK ${p.lat.toFixed(5)},${p.lng.toFixed(5)} ±${Math.round(p.accuracy)}m age=${ageS}s`);
        lastFix = p;
        handlers.onFix?.(p);
        handlers.send(p);
      },
      (err) => {
        dlog('gps', `ERR code=${err.code} ${err.message}`);
        if (err.code === err.PERMISSION_DENIED) handlers.onDenied();
        else handlers.onUnavailable?.();
      },
      // enableHighAccuracy:false → localisation basse conso (réseau/cache OS,
      // récepteur GPS non sollicité) ; maximumAge réutilise un point récent
      // plutôt que de relancer une acquisition.
      {
        enableHighAccuracy: fresh,
        maximumAge: fresh ? 0 : Math.max(0, POSITION_INTERVAL_MS - 15_000),
        timeout: 30_000,
      },
    );
  };

  takeFix(); // premier point dès l'arrivée, sans attendre le premier intervalle
  timer = setInterval(takeFix, POSITION_INTERVAL_MS);

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    getLastFix: () => lastFix,
    resend() {
      if (lastFix) handlers.send({ ...lastFix, ts: Date.now() });
    },
    refresh: () => takeFix(true),
  };
}
