import { describe, it, expect, vi } from 'vitest';
import { OllamaProvider, type PostJson, type GetJson } from '../src/ai/ollama.js';

function stub(content: string): PostJson {
  return vi.fn(async () => ({ ok: true, status: 200, json: { message: { content } } }));
}

const LABELS = ['money', 'entrepreneurship', 'business', 'economy'];

describe('OllamaProvider.classify', () => {
  it('intersects model angles with the supplied labels and injects them in the prompt', async () => {
    const post = stub(JSON.stringify({ match: true, angles: ['money', 'sports', 'business'] }));
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', postJson: post });
    const r = await p.classify('buy bitcoin and start a company', LABELS);
    expect(r.match).toBe(true);
    expect(r.angles).toEqual(['money', 'business']);
    const [url, body] = (post as any).mock.calls[0];
    expect(url).toBe('http://x/api/chat');
    expect((body as any).format).toBe('json');
    const system = (body as any).messages[0].content as string;
    expect(system).toContain('money, entrepreneurship, business, economy');
  });

  it('matches labels case-insensitively and returns the canonical label', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub(JSON.stringify({ angles: ['Business'] })) });
    const r = await p.classify('quarterly earnings', ['business', 'economy']);
    expect(r).toEqual({ match: true, angles: ['business'] });
  });

  it('is not a match when no returned angle is in the label set', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub(JSON.stringify({ match: true, angles: ['sports'] })) });
    expect(await p.classify('the game', LABELS)).toEqual({ match: false, angles: [] });
  });

  it('short-circuits with no HTTP call when labels is empty', async () => {
    const post: PostJson = vi.fn(async () => ({ ok: true, status: 200, json: { message: { content: '{}' } } }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    expect(await p.classify('anything', [])).toEqual({ match: false, angles: [] });
    expect((post as any).mock.calls.length).toBe(0);
  });

  it('throws on malformed JSON content', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub('not json') });
    await expect(p.classify('x', LABELS)).rejects.toThrow();
  });

  it('throws when ollama returns non-ok', async () => {
    const post: PostJson = vi.fn(async () => ({ ok: false, status: 500, json: null }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await expect(p.classify('x', LABELS)).rejects.toThrow();
  });

  it('translates returning trimmed content', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub('  Olá mundo  ') });
    expect(await p.translate('Hello world')).toBe('Olá mundo');
  });
});

function tagsStub(names: string[]): GetJson {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: { models: names.map(name => ({ name })) },
  }));
}

describe('OllamaProvider.ready', () => {
  it('is true when the configured model is present', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', getJson: tagsStub(['gemma3:4b', 'llama3:8b']) });
    expect(await p.ready()).toBe(true);
  });

  it('is false when the configured model is absent', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', getJson: tagsStub(['llama3:8b']) });
    expect(await p.ready()).toBe(false);
  });

  it('matches a tag-less configured model against a tagged entry', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3', getJson: tagsStub(['gemma3:4b']) });
    expect(await p.ready()).toBe(true);
  });

  it('is false when ollama is unreachable', async () => {
    const getJson: GetJson = vi.fn(async () => ({ ok: false, status: 0, json: null }));
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', getJson });
    expect(await p.ready()).toBe(false);
  });

  it('memoizes a true result and does not call ollama again', async () => {
    const getJson = tagsStub(['gemma3:4b']);
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', getJson });
    expect(await p.ready()).toBe(true);
    expect(await p.ready()).toBe(true);
    expect((getJson as any).mock.calls.length).toBe(1);
  });
});

describe('OllamaProvider.summarize', () => {
  it('summarizes posts, mentions the tag in the system prompt, and returns trimmed prose', async () => {
    const post = stub('  Rates dominated the week.  ');
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    const out = await p.summarize(['post one', 'post two'], 'money');
    expect(out).toBe('Rates dominated the week.');
    const [url, body] = (post as any).mock.calls[0];
    expect(url).toBe('http://x/api/chat');
    expect((body as any).format).toBeUndefined(); // prose, not json mode
    const system = (body as any).messages[0].content as string;
    expect(system).toContain('money');
  });

  it('throws when ollama returns non-ok', async () => {
    const post: PostJson = vi.fn(async () => ({ ok: false, status: 500, json: null }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await expect(p.summarize(['x'], 'money')).rejects.toThrow();
  });

  it('uses a longer 120s timeout to allow for cold model-load and multi-post summaries', async () => {
    const post = stub('summary');
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await p.summarize(Array.from({ length: 40 }, (_, i) => `post ${i}`), 'money');
    expect((post as any).mock.calls[0][2]).toBe(120000);
  });

  it('does not affect the default 30s timeout used by classify/translate', async () => {
    const post = stub('  Olá mundo  ');
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await p.translate('Hello world');
    expect((post as any).mock.calls[0][2]).toBe(30000);
  });
});

describe('OllamaProvider input hygiene', () => {
  it('does not throw when the model returns match as an array', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub(JSON.stringify({ match: ['money'], angles: ['money'] })) });
    const r = await p.classify('quarterly earnings', ['money', 'business']);
    expect(r).toEqual({ match: true, angles: ['money'] });
  });

  it('strips URLs from the text sent to classify', async () => {
    const post = stub(JSON.stringify({ angles: [] }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await p.classify('black holes https://www.economist.com/science/black-holes?utm_campaign=x', ['economy']);
    const userMsg = (post as any).mock.calls[0][1].messages[1].content as string;
    expect(userMsg).not.toContain('http');
    expect(userMsg).not.toContain('economist.com');
    expect(userMsg).toContain('black holes');
  });

  it('strips URLs from each post text sent to summarize', async () => {
    const post = stub('summary');
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await p.summarize(['see https://example.com/a?b=1 now'], 'money');
    const userMsg = (post as any).mock.calls[0][1].messages[1].content as string;
    expect(userMsg).not.toContain('http');
    expect(userMsg).toContain('see');
    expect(userMsg).toContain('now');
  });
});
