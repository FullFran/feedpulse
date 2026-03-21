import { Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Shared Prometheus registry singleton used by both the API and Worker processes.
 * Both processes record metrics to this same registry, enabling unified
 * /metrics endpoint exposure from the API process.
 */
export const SHARED_METRICS_REGISTRY = new Registry();

collectDefaultMetrics({ register: SHARED_METRICS_REGISTRY });
