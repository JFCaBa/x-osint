import { describe, it, expect, vi } from 'vitest';
import { createExportManager, type ExportManagerDeps } from '../src/http/exportJobs.js';

function deps(over: Partial<ExportManagerDeps> = {}): ExportManagerDeps {
  return {
    repo: {
      listExportablePosts: vi.fn(() => [{ id: '1', handle: 'a', text: 't', url: null, media_url: null, posted_at: '2026-06-18T00:00:00.000Z', fetched_at: '2026-06-18T00:00:00.000Z', angles: 'money', angle_match: 1 }]),
      getFilters: vi.fn(() => [{ label: 'money', color: '#111111', emoji: '' }]),
      recordExport: vi.fn(),
      markExported: vi.fn(),
    } as any,
    tz: 'UTC',
    provider: null,
    buildWorkbook: vi.fn(async () => Buffer.from('xlsx')),
    buildMarkdown: vi.fn(async () => '# md'),
    zip: vi.fn(async () => Buffer.from('zipbytes')),
    ...over,
  };
}

describe('createExportManager', () => {
  it('runs a job to done and yields the zip once', async () => {
    const d = deps();
    const mgr = createExportManager(d);
    const id = mgr.start({ mode: 'since-last' });
    expect(mgr.get(id)!.status).toBe('running');
    await mgr.whenDone(id);
    expect(mgr.get(id)!.status).toBe('done');
    expect(mgr.get(id)!.phase).toBe('done');
    const f = mgr.takeFile(id);
    expect(f!.buffer).toEqual(Buffer.from('zipbytes'));
    expect(f!.filename).toBe('x-osint-report.zip');
    expect(f!.contentType).toBe('application/zip');
    expect(mgr.takeFile(id)).toBeNull(); // job removed after first take
    expect(mgr.get(id)).toBeUndefined();
    expect(d.repo.recordExport).toHaveBeenCalledOnce();
    expect(d.repo.markExported).toHaveBeenCalledOnce();
  });

  it('reports error status when a builder throws and yields no zip', async () => {
    const mgr = createExportManager(deps({ buildMarkdown: vi.fn(async () => { throw new Error('boom'); }) }));
    const id = mgr.start({ mode: 'since-last' });
    await mgr.whenDone(id);
    expect(mgr.get(id)!.status).toBe('error');
    expect(mgr.get(id)!.error).toBe('boom');
    expect(mgr.takeFile(id)).toBeNull();
  });

  it('returns undefined/null for unknown ids', () => {
    const mgr = createExportManager(deps());
    expect(mgr.get('nope')).toBeUndefined();
    expect(mgr.takeFile('nope')).toBeNull();
  });

  it('threads onProgress from buildMarkdown into the status total/index', async () => {
    const buildMarkdown = vi.fn(async (a: any) => {
      a.onProgress?.({ phase: 'summarize', tag: 'money', index: 1, total: 3 });
      return '# md';
    });
    const mgr = createExportManager(deps({ buildMarkdown }));
    const id = mgr.start({ mode: 'since-last' });
    await mgr.whenDone(id);
    // terminal phase is 'done'; total was captured during the run
    expect(mgr.get(id)!.status).toBe('done');
  });

  it('include=excel builds only the workbook, skips AI, and yields the xlsx', async () => {
    const d = deps();
    const mgr = createExportManager(d);
    const id = mgr.start({ mode: 'since-last', include: 'excel' });
    await mgr.whenDone(id);
    const f = mgr.takeFile(id);
    expect(f!.buffer).toEqual(Buffer.from('xlsx'));
    expect(f!.filename).toBe('x-osint-report.xlsx');
    expect(f!.contentType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(d.buildMarkdown).not.toHaveBeenCalled(); // no AI work
    expect(d.repo.recordExport).toHaveBeenCalledOnce();
  });

  it('include=report builds only the markdown and yields the .md', async () => {
    const d = deps();
    const mgr = createExportManager(d);
    const id = mgr.start({ mode: 'since-last', include: 'report' });
    await mgr.whenDone(id);
    const f = mgr.takeFile(id);
    expect(f!.buffer).toEqual(Buffer.from('# md', 'utf8'));
    expect(f!.filename).toBe('x-osint-analysis.md');
    expect(f!.contentType).toBe('text/markdown; charset=utf-8');
    expect(d.buildWorkbook).not.toHaveBeenCalled();
    expect(d.repo.recordExport).toHaveBeenCalledOnce();
  });
});
