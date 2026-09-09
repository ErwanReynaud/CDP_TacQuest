import { describe, expect, it } from 'vitest';
import { escapeHtml, safeColor } from './util';

describe('escapeHtml', () => {
  it('neutralise les caractères dangereux y compris les guillemets', () => {
    expect(escapeHtml(`<img src=x onerror=alert(1)>`)).not.toContain('<');
    expect(escapeHtml(`"'&`)).toBe('&#34;&#39;&#38;');
  });
});

describe('safeColor', () => {
  it('accepte les couleurs hex de la palette', () => {
    for (const c of ['#e8d44d', '#4f9dd9', '#5fb35a', '#c0564f', '#fff', '#11223344']) {
      expect(safeColor(c)).toBe(c);
    }
  });

  it('accepte un nom de couleur purement alphabétique', () => {
    expect(safeColor('red')).toBe('red');
  });

  it('rejette toute tentative d’évasion d’attribut ou d’injection CSS', () => {
    for (const c of [
      '"><img src=x onerror=alert(1)>',
      'red;background:url(http://evil/x)',
      'expression(alert(1))',
      'rgb(0,0,0)', // parenthèses → rejeté (la palette n’en émet pas)
      '#xyz',
      '',
    ]) {
      expect(safeColor(c)).toBeNull();
    }
  });

  it('rejette les valeurs non-chaîne', () => {
    expect(safeColor(undefined)).toBeNull();
    expect(safeColor(123)).toBeNull();
  });
});
