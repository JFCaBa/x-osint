import { describe, it, expect, vi } from 'vitest';
import { OllamaProvider, type PostJson } from '../src/ai/ollama.js';

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
