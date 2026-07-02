import { randomUUID } from 'node:crypto';
import type { createRepo } from '../store/repo.js';
import type { AiProvider } from '../ai/provider.js';
import type { AnalysisDeps } from '../reports/analysis.js';
import type { Post } from '../types.js';

type Repo = ReturnType<typeof createRepo>;

export type ReportParams = { mode: 'since-last' | 'range'; from?: string; to?: string; include?: 'both' | 'excel' | 'report' };

type Phase = 'spreadsheet' | 'summarize' | 'translate' | 'bundling' | 'done' | 'error';

interface ExportJob {
  id: string;
  status: 'running' | 'done' | 'error';
  phase: Phase;
  tag: string | null;
  index: number;
  total: number;
  file: Buffer | null;
  filename: string;
  contentType: string;
  error: string | null;
  createdAt: number;
  promise?: Promise<void>;
}

export interface PublicStatus {
  status: 'running' | 'done' | 'error';
  phase: Phase;
  tag: string | null;
  index: number;
  total: number;
  error: string | null;
}

export interface ExportManagerDeps {
  repo: Repo;
  tz: string;
  provider: AiProvider | null;
  buildWorkbook: (posts: Post[], tz: string) => Promise<Buffer>;
  buildMarkdown: (deps: AnalysisDeps) => Promise<string>;
  zip: (files: { xlsx: Buffer; markdown: string }) => Promise<Buffer>;
}

export interface ExportManager {
  start(params: ReportParams): string;
  get(jobId: string): PublicStatus | undefined;
  takeFile(jobId: string): { buffer: Buffer; filename: string; contentType: string } | null;
  whenDone(jobId: string): Promise<void>;
}

const TTL_MS = 10 * 60_000;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function createExportManager(deps: ExportManagerDeps): ExportManager {
  const jobs = new Map<string, ExportJob>();

  function sweep(): void {
    const now = Date.now();
    for (const [id, j] of jobs) {
      if (now - j.createdAt > TTL_MS) jobs.delete(id);
    }
  }

  async function run(job: ExportJob, params: ReportParams): Promise<void> {
    try {
      const include = params.include ?? 'both';
      const posts = deps.repo.listExportablePosts(params);
      let xlsx: Buffer | undefined;
      let markdown: string | undefined;
      if (include !== 'report') {
        job.phase = 'spreadsheet';
        xlsx = await deps.buildWorkbook(posts, deps.tz);
      }
      if (include !== 'excel') {
        markdown = await deps.buildMarkdown({
          posts,
          filters: deps.repo.getFilters(),
          tz: deps.tz,
          provider: deps.provider,
          onProgress: (ev) => {
            job.phase = ev.phase;
            job.tag = ev.tag;
            job.index = ev.index;
            job.total = ev.total;
          },
        });
      }
      let file: Buffer;
      if (include === 'excel') {
        file = xlsx!;
        job.filename = 'x-osint-report.xlsx';
        job.contentType = XLSX_TYPE;
      } else if (include === 'report') {
        file = Buffer.from(markdown!, 'utf8');
        job.filename = 'x-osint-analysis.md';
        job.contentType = 'text/markdown; charset=utf-8';
      } else {
        job.phase = 'bundling';
        job.tag = null;
        file = await deps.zip({ xlsx: xlsx!, markdown: markdown! });
        job.filename = 'x-osint-report.zip';
        job.contentType = 'application/zip';
      }
      const coveredUpto = posts.length ? posts[posts.length - 1]!.posted_at : null;
      deps.repo.recordExport({ coveredUpto, rowCount: posts.length });
      deps.repo.markExported(posts.map(p => p.id), new Date().toISOString());
      job.file = file;
      job.status = 'done';
      job.phase = 'done';
    } catch (err) {
      job.status = 'error';
      job.phase = 'error';
      job.error = err instanceof Error ? err.message : 'export failed';
    }
  }

  return {
    start(params: ReportParams): string {
      sweep();
      const job: ExportJob = {
        id: randomUUID(),
        status: 'running',
        phase: 'spreadsheet',
        tag: null,
        index: 0,
        total: 0,
        file: null,
        filename: '',
        contentType: '',
        error: null,
        createdAt: Date.now(),
      };
      jobs.set(job.id, job);
      job.promise = run(job, params);
      return job.id;
    },
    get(jobId: string): PublicStatus | undefined {
      const j = jobs.get(jobId);
      if (!j) return undefined;
      return { status: j.status, phase: j.phase, tag: j.tag, index: j.index, total: j.total, error: j.error };
    },
    takeFile(jobId: string): { buffer: Buffer; filename: string; contentType: string } | null {
      const j = jobs.get(jobId);
      if (!j || j.status !== 'done' || !j.file) return null;
      jobs.delete(jobId);
      return { buffer: j.file, filename: j.filename, contentType: j.contentType };
    },
    whenDone(jobId: string): Promise<void> {
      return jobs.get(jobId)?.promise ?? Promise.resolve();
    },
  };
}
