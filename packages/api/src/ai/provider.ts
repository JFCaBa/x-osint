export const ANGLES = ['money', 'entrepreneurship', 'business', 'economy'] as const;
export type Angle = (typeof ANGLES)[number];

export interface ClassifyResult {
  match: boolean;
  angles: string[];
}

export interface AiProvider {
  classify(text: string): Promise<ClassifyResult>;
  translate(text: string, target?: string): Promise<string>;
}
