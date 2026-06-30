import { describe, it, expect } from 'vitest';
import { badgeStyle } from '../src/services/badges';

describe('badgeStyle', () => {
  it('derives border/text color from the filter color', () => {
    const s = badgeStyle({ label: 'money', color: '#22c55e', emoji: '💰' });
    expect(s.borderColor).toBe('#22c55e');
    expect(s.color).toBe('#22c55e');
    expect(s.backgroundColor).toBe('#22c55e22');
  });

  it('falls back to neutral grey for an unknown filter', () => {
    const s = badgeStyle(undefined);
    expect(s.borderColor).toBe('#6b7280');
    expect(s.color).toBe('#9ca3af');
  });
});
