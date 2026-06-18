import { describe, it, expect } from 'vitest';
import { signToken, verifyToken, comparePassword } from '../src/auth/token.js';

describe('token', () => {
  it('verifies a freshly signed token', () => {
    const t = signToken('secret', 7);
    expect(verifyToken('secret', t)).toBe(true);
  });
  it('rejects a token signed with a different secret', () => {
    const t = signToken('secret', 7);
    expect(verifyToken('other', t)).toBe(false);
  });
  it('rejects an expired token', () => {
    const past = () => Date.parse('2020-01-01T00:00:00Z');
    const t = signToken('secret', 7, past);
    expect(verifyToken('secret', t)).toBe(false); // now() is real → far past exp
  });
  it('rejects garbage tokens', () => {
    expect(verifyToken('secret', 'garbage')).toBe(false);
    expect(verifyToken('secret', 'a.b.c')).toBe(false);
  });
  it('comparePassword is true only for equal strings', () => {
    expect(comparePassword('pw', 'pw')).toBe(true);
    expect(comparePassword('pw', 'nope')).toBe(false);
  });
});
