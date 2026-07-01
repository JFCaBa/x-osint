import JSZip from 'jszip';

export async function zipReport(files: { xlsx: Buffer; markdown: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('x-osint-report.xlsx', files.xlsx);
  zip.file('x-osint-analysis.md', files.markdown);
  return zip.generateAsync({ type: 'nodebuffer' });
}
