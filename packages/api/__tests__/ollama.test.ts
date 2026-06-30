import { describe, it, expect, vi } from 'vitest';
import { OllamaProvider, type PostJson } from '../src/ai/ollama.js';

function stub(content: string): PostJson {
  return vi.fn(async () => ({ ok: true, status: 200, json: { message: { content } } }));
}

describe('OllamaProvider', () => {
  it('classifies and keeps only valid angles', async () => {
    const post = stub(JSON.stringify({ match: true, angles: ['money', 'sports', 'business'] }));
    const p = new OllamaProvider({ host: 'http://x', model: 'gemma3:4b', postJson: post });
    const r = await p.classify('buy bitcoin and start a company');
    expect(r.match).toBe(true);
    expect(r.angles).toEqual(['money', 'business']);
    const [url, body] = (post as any).mock.calls[0];
    expect(url).toBe('http://x/api/chat');
    expect((body as any).model).toBe('gemma3:4b');
    expect((body as any).format).toBe('json');
  });

  it('treats non-empty angles as a match even if match flag missing', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub(JSON.stringify({ angles: ['economy'] })) });
    expect((await p.classify('inflation rises')).match).toBe(true);
  });

  it('throws on malformed JSON content', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub('not json') });
    await expect(p.classify('x')).rejects.toThrow();
  });

  it('throws when ollama returns non-ok', async () => {
    const post: PostJson = vi.fn(async () => ({ ok: false, status: 500, json: null }));
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: post });
    await expect(p.classify('x')).rejects.toThrow();
  });

  it('translates returning trimmed content', async () => {
    const p = new OllamaProvider({ host: 'http://x', model: 'm', postJson: stub('  Olá mundo  ') });
    expect(await p.translate('Hello world')).toBe('Olá mundo');
  });
});
