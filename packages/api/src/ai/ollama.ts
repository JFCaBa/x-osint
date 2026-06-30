import { z } from 'zod';
import { ANGLES, type AiProvider, type ClassifyResult } from './provider.js';

const TIMEOUT_MS = 30_000;

export type PostJson = (url: string, body: unknown, timeoutMs: number)
  => Promise<{ ok: boolean; status: number; json: unknown }>;

const defaultPostJson: PostJson = async (url, body, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  } finally {
    clearTimeout(timer);
  }
};

const CLASSIFY_SYSTEM =
  'You are a strict text classifier. Decide whether the post has at least one of these angles: ' +
  'money, entrepreneurship, business, economy. Respond ONLY with JSON of the form ' +
  '{"match": boolean, "angles": string[]} where angles is a subset of ' +
  '["money","entrepreneurship","business","economy"]. No prose.';

const TRANSLATE_SYSTEM =
  'You are a translator. Translate the user message into European Portuguese. ' +
  'Output ONLY the translation, with no preamble, quotes, or notes.';

const classifySchema = z.object({
  match: z.boolean().optional(),
  angles: z.array(z.string()).optional(),
});

const messageSchema = z.object({ message: z.object({ content: z.string() }) });

export class OllamaProvider implements AiProvider {
  private host: string;
  private model: string;
  private postJson: PostJson;

  constructor(deps: { host: string; model: string; postJson?: PostJson }) {
    this.host = deps.host.replace(/\/$/, '');
    this.model = deps.model;
    this.postJson = deps.postJson ?? defaultPostJson;
  }

  private async chat(system: string, user: string, json: boolean): Promise<string> {
    const res = await this.postJson(`${this.host}/api/chat`, {
      model: this.model,
      stream: false,
      ...(json ? { format: 'json' } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }, TIMEOUT_MS);
    if (!res.ok) throw new Error(`ollama request failed: ${res.status}`);
    return messageSchema.parse(res.json).message.content;
  }

  async classify(text: string): Promise<ClassifyResult> {
    const content = await this.chat(CLASSIFY_SYSTEM, text, true);
    const parsed = classifySchema.parse(JSON.parse(content));
    const valid = (ANGLES as readonly string[]);
    const angles = (parsed.angles ?? []).filter(a => valid.includes(a));
    return { match: parsed.match === true || angles.length > 0, angles };
  }

  async translate(text: string): Promise<string> {
    const content = await this.chat(TRANSLATE_SYSTEM, text, false);
    return content.trim();
  }
}
