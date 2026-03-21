export interface Feed {
  id: number;
  url: string;
  status: 'active' | 'paused' | 'error';
  etag: string | null;
  lastModified: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string;
  pollIntervalSeconds: number;
  errorCount: number;
  lastError: string | null;
  avgResponseMs: number | null;
  avgItemsPerDay: number | null;
  createdAt: string;
  updatedAt: string;
}
