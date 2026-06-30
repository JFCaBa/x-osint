import type { Filter } from './api';

export function badgeStyle(filter?: Filter): Record<string, string> {
  if (!filter) {
    return { borderColor: '#6b7280', color: '#9ca3af', backgroundColor: '#6b728022' };
  }
  return { borderColor: filter.color, color: filter.color, backgroundColor: `${filter.color}22` };
}
