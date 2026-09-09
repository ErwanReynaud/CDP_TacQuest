import L from 'leaflet';
import type { MemberPublic, Position } from '@tq/shared/protocol';
import { escapeHtml } from '../util';

interface Tracked {
  marker: L.Marker;
  /** Clé du dernier style appliqué — évite de re-setIcon inutilement. */
  styleKey: string;
  tooltipKey: string;
}

// Un divIcon par état visuel suffit (le contenu est purement CSS) : partagés
// entre tous les marqueurs.
const SELF_ICON = L.divIcon({
  className: 'gps-dot-self',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});
const MEMBER_ICON = L.divIcon({
  className: 'gps-dot',
  iconSize: [13, 13],
  iconAnchor: [6.5, 6.5],
});
const MEMBER_ICON_OFF = L.divIcon({
  className: 'gps-dot is-disconnected',
  iconSize: [13, 13],
  iconAnchor: [6.5, 6.5],
});

/**
 * Positions sur la carte : soi-même en point GPS bleu (alimenté directement par
 * les fixes locaux, donc fonctionnel hors salle), les coéquipiers en points de
 * couleur étiquetés de leur indicatif.
 */
export class MarkerLayer {
  private readonly tracked = new Map<string, Tracked>();
  private selfMarker: L.Marker | null = null;
  private accuracyCircle: L.Circle | null = null;
  private selfId: string | null = null;

  constructor(
    private readonly map: L.Map,
    private readonly onClick?: (memberId: string) => void,
  ) {}

  /** Id du membre local en salle (son entrée roster est ignorée par upsert) ; null en solo. */
  setSelfId(id: string | null): void {
    this.selfId = id;
  }

  /** Point GPS local (bleu) + cercle de précision — indépendant de la salle. */
  setSelf(p: Position): void {
    if (!this.selfMarker) {
      this.selfMarker = L.marker([p.lat, p.lng], {
        icon: SELF_ICON,
        zIndexOffset: 1000,
        interactive: false,
      }).addTo(this.map);
    } else {
      this.selfMarker.setLatLng([p.lat, p.lng]);
    }
    this.updateAccuracy(p.lat, p.lng, p.accuracy);
  }

  /** Réconciliation complète avec l'état courant (roster + styles). */
  sync(members: Map<string, MemberPublic>): void {
    for (const id of this.tracked.keys()) {
      if (!members.has(id)) this.remove(id);
    }
    for (const member of members.values()) this.upsert(member);
  }

  upsert(member: MemberPublic): void {
    if (member.id === this.selfId) return; // soi-même : rendu par setSelf
    const pos = member.lastPosition;
    if (!pos) return; // pas encore de fix : rien à afficher

    // Seul état visuel : grisé tant que le membre n'est pas (re)connecté.
    const styleKey = member.connected ? 'on' : 'off';
    const tooltipKey = escapeHtml(member.callsign);

    let t = this.tracked.get(member.id);
    if (!t) {
      const marker = L.marker([pos.lat, pos.lng], {
        icon: member.connected ? MEMBER_ICON : MEMBER_ICON_OFF,
      });
      marker.bindTooltip(tooltipKey, {
        permanent: true,
        direction: 'bottom',
        offset: [0, 6],
        className: 'tq-tooltip',
      });
      marker.on('click', (e) => {
        L.DomEvent.stop(e);
        this.onClick?.(member.id);
      });
      marker.addTo(this.map);
      t = { marker, styleKey, tooltipKey };
      this.tracked.set(member.id, t);
    } else {
      t.marker.setLatLng([pos.lat, pos.lng]);
      if (t.styleKey !== styleKey) {
        t.marker.setIcon(member.connected ? MEMBER_ICON : MEMBER_ICON_OFF);
        t.styleKey = styleKey;
      }
      if (t.tooltipKey !== tooltipKey) {
        t.marker.setTooltipContent(tooltipKey);
        t.tooltipKey = tooltipKey;
      }
    }
  }

  /** Retire les coéquipiers (sortie de salle) ; le point GPS local reste. */
  clearMembers(): void {
    for (const id of [...this.tracked.keys()]) this.remove(id);
  }

  remove(memberId: string): void {
    const t = this.tracked.get(memberId);
    if (!t) return;
    t.marker.remove();
    this.tracked.delete(memberId);
  }

  private updateAccuracy(lat: number, lng: number, accuracy: number): void {
    if (!this.accuracyCircle) {
      // Contour seul : rempli, un fix peu précis (mode basse conso) couvre
      // tout l'écran et pose un voile bleu uniforme sur la carte.
      this.accuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        weight: 1,
        color: '#0033ff',
        fill: false,
        interactive: false,
      }).addTo(this.map);
    } else {
      this.accuracyCircle.setLatLng([lat, lng]);
      this.accuracyCircle.setRadius(accuracy);
    }
  }
}
