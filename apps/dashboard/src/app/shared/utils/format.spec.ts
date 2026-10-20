import { formatNumber, formatPercent, formatScore, formatSigned } from './format';

describe('format', () => {
  it('agrupa miles con espacio fino, también con 4 cifras', () => {
    expect(formatNumber(184320)).toBe('184 320');
    expect(formatNumber(1286)).toBe('1 286');
    expect(formatNumber(642)).toBe('642');
  });
  it('usa coma decimal', () => {
    expect(formatNumber(383.94, 1)).toBe('383,9');
    expect(formatScore(0.6649)).toBe('0,66');
  });
  it('porcentajes con espacio duro y sin ",0" sobrante', () => {
    expect(formatPercent(0.499)).toBe('49,9 %');
    expect(formatPercent(0.64)).toBe('64 %');
  });
  it('null / NaN → raya', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
  });
  it('signo menos tipográfico', () => {
    expect(formatNumber(-1200)).toBe('−1 200');
    expect(formatSigned(4, '-')).toBe('−4');
  });
});
