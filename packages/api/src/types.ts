export interface Post {
  id: string;
  handle: string;
  text: string;
  url: string | null;
  media_url: string | null;
  posted_at: string;   // ISO 8601
  fetched_at: string;  // ISO 8601
  ai_status?: string | null;
  angle_match?: number | null;
  angles?: string | null;
  text_pt?: string | null;
  exported_at?: string | null;
}

export interface Account {
  handle: string;
  display_name: string | null;
  enabled: boolean;
  added_at: string;
  last_fetched_at: string | null;
  last_status: 'ok' | 'error' | null;
}

export interface NitterInstance {
  url: string;
  userAgent: string;
}

export interface Config {
  password: string;
  port: number;
  dataDir: string;
  pollIntervalMin: number;
  retentionDays: number;
  tokenTtlDays: number;
  tokenSecret: string;
  nitterInstances: NitterInstance[];
  aiProvider: 'ollama' | 'none';
  ollamaHost: string;
  aiModel: string;
  reportTz: string;
}
