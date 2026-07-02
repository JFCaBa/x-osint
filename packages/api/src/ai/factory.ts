import type { Config } from '../types.js';
import type { AiProvider } from './provider.js';
import { OllamaProvider } from './ollama.js';

export function createAiProvider(config: Config): AiProvider | null {
  if (config.aiProvider === 'none') return null;
  return new OllamaProvider({
    host: config.ollamaHost,
    model: config.aiModel,
    summarizeModel: config.summarizeModel,
  });
}
