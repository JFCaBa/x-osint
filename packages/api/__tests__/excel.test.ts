import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildWorkbookBuffer, formatReportDate } from '../src/reports/excel.js';
import type { Post } from '../src/types.js';

function post(over: Partial<Post>): Post {
  return { id: '1', handle: 'alice', text: 'orig', url: 'https://x.com/alice/status/1', media_url: null, posted_at: '2026-06-18T13:30:00.000Z', fetched_at: '2026-06-18T13:30:00.000Z', text_pt: 'traduzido', angle_match: 1, ...over };
}

describe('excel report', () => {
  it('formats a date in the given timezone', () => {
    // 2026-06-18T13:30Z is 14:30 in Europe/London (BST = UTC+1)
    expect(formatReportDate('2026-06-18T13:30:00.000Z', 'Europe/London')).toBe('2026-06-18 14:30');
    expect(formatReportDate('2026-06-18T13:30:00.000Z', 'UTC')).toBe('2026-06-18 13:30');
  });

  it('builds a workbook with the exact header row and translated text', async () => {
    const buf = await buildWorkbookBuffer([post({})], 'UTC');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('Stories')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'Date', 'X handle', 'Text (PT)', 'Post link']);
    const r = ws.getRow(2);
    expect(r.getCell(1).value).toBe('2026-06-18 13:30');
    expect(r.getCell(2).value).toBe('@alice');
    expect(r.getCell(3).value).toBe('traduzido');
    expect(r.getCell(4).value).toBe('https://x.com/alice/status/1');
  });

  it('falls back to original text when translation is missing', async () => {
    const buf = await buildWorkbookBuffer([post({ text_pt: null, text: 'fallback' })], 'UTC');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.getWorksheet('Stories')!.getRow(2).getCell(3).value).toBe('fallback');
  });
});
