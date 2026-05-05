import { describe, it, expect } from 'vitest';
import { worstOf } from '../OpsHealthDots';
import type { ProbeStatus } from '../../types';

describe('worstOf', () => {
  it('returns ok when all are ok', () => {
    expect(worstOf(['ok', 'ok', 'ok'])).toBe('ok');
  });
  it('returns warn over ok', () => {
    expect(worstOf(['ok', 'warn', 'ok'])).toBe('warn');
  });
  it('returns red over warn', () => {
    expect(worstOf(['ok', 'warn', 'red'])).toBe('red');
  });
  it('returns needs_human over red', () => {
    expect(worstOf(['needs_human', 'red', 'ok'] as ProbeStatus[])).toBe('needs_human');
  });
  it('treats unknown as below ok', () => {
    expect(worstOf(['unknown', 'unknown'])).toBe('unknown');
  });
});
