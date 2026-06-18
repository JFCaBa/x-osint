import { describe, it, expect } from 'vitest';
import { makeId } from '../src/fetcher/id.js';

describe('makeId', () => {
  it('is stable for the same input', () => {
    expect(makeId('twitter:@h:123', 'hello')).toBe(makeId('twitter:@h:123', 'hello'));
  });
  it('differs for different input', () => {
    expect(makeId('twitter:@h:123', 'hello')).not.toBe(makeId('twitter:@h:124', 'hello'));
  });
  it('is prefixed with x-', () => {
    expect(makeId('a', 'b')).toMatch(/^x-/);
  });
});
