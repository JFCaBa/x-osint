export interface ClassifyResult {
  match: boolean;
  angles: string[];
}

export interface AiProvider {
  classify(text: string, labels: string[]): Promise<ClassifyResult>;
  translate(text: string, target?: string): Promise<string>;
  summarize(posts: string[], tag: string): Promise<string>;
  ready?(): Promise<boolean>;
}
