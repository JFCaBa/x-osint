import ExcelJS from 'exceljs';
import type { Post } from '../types.js';

export function formatReportDate(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso)).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  // Intl can emit "24" for midnight under hourCycle quirks; normalize.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}`;
}

export async function buildWorkbookBuffer(posts: Post[], tz: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stories');
  ws.columns = [
    { header: 'Date', key: 'date', width: 18 },
    { header: 'X handle', key: 'handle', width: 18 },
    { header: 'Text (PT)', key: 'text', width: 80 },
    { header: 'Post link', key: 'link', width: 45 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const p of posts) {
    ws.addRow({
      date: formatReportDate(p.posted_at, tz),
      handle: `@${p.handle}`,
      text: p.text_pt ?? p.text,
      link: p.url ?? '',
    });
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
