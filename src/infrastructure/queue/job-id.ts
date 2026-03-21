export function buildQueueJobId(prefix: string, identifier: string | number): string {
  return `${prefix}-${identifier}`;
}
