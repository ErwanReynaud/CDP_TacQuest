import { describe, expect, it } from 'vitest';
import { parseGeocodeResponse } from './geocode';

const address = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [2.331303, 48.869141] },
  properties: { label: '12 Rue de la Paix 75002 Paris', city: 'Paris', _type: 'address' },
};

const poi = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [2.539408, 47.640007] },
  properties: {
    toponym: 'Bois de la Grille',
    category: ['bois', 'élément topographique ou forestier'],
    city: ['Coullons'],
    _type: 'poi',
  },
};

describe('parseGeocodeResponse', () => {
  it('extrait adresses et POI (champs chaîne ou tableau)', () => {
    const out = parseGeocodeResponse({ type: 'FeatureCollection', features: [address, poi] });
    expect(out).toEqual([
      { name: '12 Rue de la Paix 75002 Paris', context: 'Paris', lat: 48.869141, lng: 2.331303 },
      { name: 'Bois de la Grille', context: 'bois · Coullons', lat: 47.640007, lng: 2.539408 },
    ]);
  });

  it('ignore les features malformées sans casser', () => {
    const out = parseGeocodeResponse({
      features: [
        {},
        { geometry: { coordinates: ['x', 'y'] }, properties: { label: 'KO' } },
        { geometry: { coordinates: [1, 2] }, properties: {} }, // sans nom
        poi,
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe('Bois de la Grille');
  });

  it('tolère une réponse inattendue', () => {
    expect(parseGeocodeResponse(null)).toEqual([]);
    expect(parseGeocodeResponse({})).toEqual([]);
    expect(parseGeocodeResponse('oops')).toEqual([]);
  });
});
