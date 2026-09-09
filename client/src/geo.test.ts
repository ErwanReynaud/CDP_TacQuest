import { describe, expect, it } from 'vitest';
import { distanceM } from './geo';

describe('distanceM', () => {
  it('ordre de grandeur correct (1° lat ≈ 111 km)', () => {
    const d = distanceM({ lat: 45, lng: 5 }, { lat: 46, lng: 5 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});
