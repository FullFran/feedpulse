import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALERT_DELIVERY_QUEUE_NAME, FETCH_FEED_QUEUE_NAME } from '../src/infrastructure/queue/queue.constants';

/**
 * The KEDA ScaledObject scales the worker by reading the BullMQ backlog
 * straight out of Redis, at `bull:<queue>:wait`.
 *
 * That coupling is invisible from TypeScript: renaming a queue constant, or a
 * BullMQ upgrade that changed its key layout, would leave the ScaledObject
 * pointing at a list that never exists. KEDA would keep reporting Ready=True
 * and simply never scale -- a silent failure that only shows up as a backlog
 * growing with one worker attached.
 *
 * Verified empirically against BullMQ 6.0.9: enqueuing two jobs on `fetch-feed`
 * produces `bull:fetch-feed:wait` with LLEN 2.
 */
describe('KEDA ScaledObject', () => {
  const manifest = readFileSync(join(__dirname, '..', 'k8s', 'keda', 'scaledobject.yaml'), 'utf8');

  it.each([FETCH_FEED_QUEUE_NAME, ALERT_DELIVERY_QUEUE_NAME])(
    'scales on the BullMQ waiting list for %s',
    (queueName) => {
      expect(manifest).toContain(`listName: bull:${queueName}:wait`);
    },
  );

  // The KEDA operator runs in its own namespace, so a short service name does
  // not resolve. This asserts the FQDN survives future edits.
  it('addresses Redis by fully qualified name', () => {
    expect(manifest).toContain('address: redis.feedpulse.svc.cluster.local:6379');
    expect(manifest).not.toMatch(/address:\s*redis:6379\s*$/m);
  });
});
