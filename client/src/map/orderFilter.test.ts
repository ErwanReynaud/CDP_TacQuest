import { describe, expect, it } from 'vitest';
import type { OrderMessage } from '@tq/shared/protocol';
import { visibleGraphics, visibleWaypoints } from './orderFilter';

const graphic = (id: string, coords: [number, number][]): OrderMessage => ({
  id,
  authorId: 'a1',
  ts: 1,
  kind: 'graphic',
  payload: {
    kind: 'graphic',
    geojson: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    },
    style: { color: '#fff', arrow: true },
  },
});

const remove = (id: string, orderId: string): OrderMessage => ({
  id,
  authorId: 'a1',
  ts: 2,
  kind: 'remove',
  payload: { kind: 'remove', orderId },
});

describe('visibleGraphics', () => {
  it('convertit le GeoJSON [lng,lat] en [lat,lng]', () => {
    const orders = new Map([['g1', graphic('g1', [[5.7, 45.1], [5.8, 45.2]])]]);
    const out = visibleGraphics(orders);
    expect(out).toHaveLength(1);
    expect(out[0]!.latlngs).toEqual([[45.1, 5.7], [45.2, 5.8]]);
    expect(out[0]!.style.arrow).toBe(true);
  });

  it('conserve le nom et le figuré d’échelon d’une limite', () => {
    const order = graphic('g1', [[5.7, 45.1], [5.8, 45.2]]);
    (order.payload as { style: object }).style = { color: '#fff', label: 'LIMITE NORD', echelon: 'company' };
    const out = visibleGraphics(new Map([['g1', order]]));
    expect(out[0]!.style.label).toBe('LIMITE NORD');
    expect(out[0]!.style.echelon).toBe('company');
  });

  it('masque un graphique visé par un remove', () => {
    const orders = new Map<string, OrderMessage>([
      ['g1', graphic('g1', [[5.7, 45.1], [5.8, 45.2]])],
      ['g2', graphic('g2', [[5.0, 45.0], [5.1, 45.0]])],
      ['r1', remove('r1', 'g1')],
    ]);
    const out = visibleGraphics(orders);
    expect(out.map((g) => g.id)).toEqual(['g2']);
  });

  it('ignore les geojson malformés et les lignes à moins de 2 points', () => {
    const bad: OrderMessage = {
      id: 'b1', authorId: 'a1', ts: 1, kind: 'graphic',
      payload: { kind: 'graphic', geojson: { geometry: { type: 'Point', coordinates: [1, 2] } } },
    };
    const single = graphic('s1', [[5.7, 45.1]]);
    const orders = new Map<string, OrderMessage>([['b1', bad], ['s1', single]]);
    expect(visibleGraphics(orders)).toHaveLength(0);
  });

  it('ignore les ordres non graphiques', () => {
    const text: OrderMessage = {
      id: 't1', authorId: 'a1', ts: 1, kind: 'text',
      payload: { kind: 'text', body: 'En avant' },
    };
    expect(visibleGraphics(new Map([['t1', text]]))).toHaveLength(0);
  });
});

describe('visibleWaypoints', () => {
  const wp = (id: string): OrderMessage => ({
    id,
    authorId: 'a2',
    ts: 1,
    kind: 'waypoint',
    payload: { kind: 'waypoint', name: 'ENI', lat: 45.1, lng: 5.7, sidc: 'SHGP-------' },
  });

  it('extrait les plots avec leurs attributs', () => {
    const out = visibleWaypoints(new Map([['w1', wp('w1')]]));
    expect(out).toEqual([
      { id: 'w1', authorId: 'a2', name: 'ENI', lat: 45.1, lng: 5.7, sidc: 'SHGP-------' },
    ]);
  });

  it('conserve la couleur d’un point nommé', () => {
    const pt: OrderMessage = {
      id: 'p1', authorId: 'a2', ts: 1, kind: 'waypoint',
      payload: { kind: 'waypoint', name: 'OBJ ALPHA', lat: 45.1, lng: 5.7, color: '#e8d44d' },
    };
    const out = visibleWaypoints(new Map([['p1', pt]]));
    expect(out[0]!.color).toBe('#e8d44d');
    expect(out[0]!.sidc).toBeUndefined();
  });

  // Compat : les ordres composés du temps des calques portent encore un champ
  // `layer`. Il n'est plus interprété — le plot doit rester visible pour tous.
  it('ignore le champ `layer` des anciens ordres', () => {
    const pt = {
      id: 'p2', authorId: 'a2', ts: 1, kind: 'waypoint',
      payload: { kind: 'waypoint', name: 'OBJ', lat: 45.1, lng: 5.7, color: '#e8d44d', layer: 'T1' },
    } as unknown as OrderMessage;
    expect(visibleWaypoints(new Map([['p2', pt]]))).toHaveLength(1);
  });

  it('masque un plot visé par un remove, sans toucher aux graphiques', () => {
    const orders = new Map<string, OrderMessage>([
      ['w1', wp('w1')],
      ['w2', wp('w2')],
      ['r1', remove('r1', 'w1')],
      ['g1', graphic('g1', [[5.7, 45.1], [5.8, 45.2]])],
    ]);
    expect(visibleWaypoints(orders).map((w) => w.id)).toEqual(['w2']);
    expect(visibleGraphics(orders)).toHaveLength(1);
  });
});
