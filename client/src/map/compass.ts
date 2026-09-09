// Lecture du cap (boussole) du téléphone, normalisée 0 = nord, sens horaire.
// iOS : `webkitCompassHeading` (déjà absolu, fiable). Android : `alpha` de
// `deviceorientationabsolute` (antihoraire → cap = 360 - alpha, corrigé de
// l'orientation de l'écran). Renvoie une fonction d'arrêt, ou null si refusé.

export type CompassStop = () => void;

interface IosOrientationEvent {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

export async function startCompass(onHeading: (deg: number) => void): Promise<CompassStop | null> {
  // iOS 13+ : permission explicite, qui doit suivre un geste utilisateur.
  const ctor = window.DeviceOrientationEvent as unknown as IosOrientationEvent | undefined;
  if (ctor && typeof ctor.requestPermission === 'function') {
    try {
      if ((await ctor.requestPermission()) !== 'granted') return null;
    } catch {
      return null;
    }
  }
  if (!('DeviceOrientationEvent' in window)) return null;

  const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  const handler = (e: Event): void => {
    const heading = readHeading(e as DeviceOrientationEvent);
    if (heading !== null) onHeading(heading);
  };
  window.addEventListener(eventName, handler, true);
  return () => window.removeEventListener(eventName, handler, true);
}

function readHeading(e: DeviceOrientationEvent): number | null {
  const webkit = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
  if (typeof webkit === 'number' && !Number.isNaN(webkit)) return webkit; // iOS
  if (e.absolute && typeof e.alpha === 'number') {
    const screenAngle = (screen.orientation?.angle ?? 0) as number;
    return norm(360 - e.alpha - screenAngle); // Android
  }
  return null;
}

function norm(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
