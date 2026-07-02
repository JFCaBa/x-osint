import type { Post, Filter } from '../types.js';
import type { AiProvider } from '../ai/provider.js';

export interface AnalysisProgress {
  phase: 'summarize' | 'translate';
  tag: string;
  index: number;
  total: number;
}

export interface AnalysisDeps {
  posts: Post[];
  filters: Filter[];
  tz: string;
  provider: AiProvider | null;
  onProgress?: (ev: AnalysisProgress) => void;
}

const MAX_KEY_POSTS = 5;
const MAX_SUMMARY_INPUT = 40;
const SNIPPET_LEN = 200;
const EN_UNAVAIL = '_AI summary unavailable._';
const PT_UNAVAIL = '_Resumo de IA indisponível._';

function dateOnly(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso)).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function rangeLabel(group: Post[], tz: string): string {
  const sorted = group.map(p => p.posted_at).sort();
  const from = dateOnly(sorted[0]!, tz);
  const to = dateOnly(sorted[sorted.length - 1]!, tz);
  return from === to ? from : `${from}–${to}`;
}

function angleSet(p: Post): string[] {
  return (p.angles ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

function groupFor(posts: Post[], label: string): Post[] {
  const want = label.toLowerCase();
  return posts.filter(p => angleSet(p).some(a => a.toLowerCase() === want));
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET_LEN ? `${t.slice(0, SNIPPET_LEN)}…` : t;
}

function keyPostLine(p: Post, usePt: boolean): string {
  const text = usePt ? (p.text_pt ?? p.text) : p.text;
  const base = `- @${p.handle}: "${snippet(text)}"`;
  return p.url ? `${base} (${p.url})` : base;
}

function keyPosts(group: Post[], usePt: boolean): string[] {
  return [...group]
    .sort((a, b) => b.posted_at.localeCompare(a.posted_at))
    .slice(0, MAX_KEY_POSTS)
    .map(p => keyPostLine(p, usePt));
}

function statsLine(group: Post[], tz: string, accountsWord: string): string {
  const accounts = new Set(group.map(p => p.handle)).size;
  return `${group.length} posts · ${accounts} ${accountsWord} · ${rangeLabel(group, tz)}`;
}

async function narratives(
  provider: AiProvider | null, texts: string[], label: string,
  emit: (phase: 'summarize' | 'translate') => void,
): Promise<{ en: string; pt: string }> {
  if (!provider) return { en: EN_UNAVAIL, pt: PT_UNAVAIL };
  emit('summarize');
  let en: string;
  try {
    en = (await provider.summarize(texts.slice(0, MAX_SUMMARY_INPUT), label)).trim() || EN_UNAVAIL;
  } catch {
    return { en: EN_UNAVAIL, pt: PT_UNAVAIL };
  }
  if (en === EN_UNAVAIL) return { en, pt: PT_UNAVAIL };
  emit('translate');
  let pt: string;
  try {
    pt = (await provider.translate(en)).trim() || PT_UNAVAIL;
  } catch {
    pt = PT_UNAVAIL;
  }
  return { en, pt };
}

interface TagBlock { label: string; group: Post[]; en: string; pt: string; }

export async function buildAnalysisMarkdown(deps: AnalysisDeps): Promise<string> {
  const { posts, filters, tz, provider } = deps;

  if (posts.length === 0) {
    return [
      '# Analysis (English)', '',
      'No matching posts for this period.', '',
      '---', '',
      '# Análise (Português)', '',
      'Sem posts correspondentes para este período.', '',
    ].join('\n');
  }

  let tags: { label: string; group: Post[] }[] = [];
  for (const f of filters) {
    const group = groupFor(posts, f.label);
    if (group.length) tags.push({ label: f.label, group });
  }
  if (tags.length === 0) tags = [{ label: 'All posts', group: posts }];

  const blocks: TagBlock[] = [];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i]!;
    const emit = (phase: 'summarize' | 'translate'): void =>
      deps.onProgress?.({ phase, tag: t.label, index: i + 1, total: tags.length });
    const { en, pt } = await narratives(provider, t.group.map(p => p.text), t.label, emit);
    blocks.push({ label: t.label, group: t.group, en, pt });
  }

  const period = rangeLabel(posts, tz);
  const lines: string[] = [];

  lines.push('# Analysis (English)', '', `_Period: ${period} · ${posts.length} posts_`, '');
  for (const b of blocks) {
    lines.push(`## ${b.label}`, statsLine(b.group, tz, 'accounts'), '', b.en, '', '**Key posts**', ...keyPosts(b.group, false), '');
  }

  lines.push('---', '');

  lines.push('# Análise (Português)', '', `_Período: ${period} · ${posts.length} posts_`, '');
  for (const b of blocks) {
    lines.push(`## ${b.label}`, statsLine(b.group, tz, 'contas'), '', b.pt, '', '**Posts principais**', ...keyPosts(b.group, true), '');
  }

  return lines.join('\n');
}
