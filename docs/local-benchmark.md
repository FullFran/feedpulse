# Local Feed Capacity Benchmark

The benchmark harness extends the local smoke fixture so it can serve many deterministic RSS feeds without relying on external sources.

## What it does

- Seeds benchmark feeds through the real `POST /api/v1/feeds` API.
- Triggers ingestion through `POST /api/v1/feeds/:id/check-now`.
- Waits for the API metrics and local fixture counts to confirm the stage completed.
- Writes per-stage artifacts under `artifacts/benchmark/<run-id>/stage-<count>/`.

## Practical scripts

```bash
npm run benchmark:stack:up
npm run benchmark:stage:100
npm run benchmark:stack:down
```

For a one-command first run:

```bash
npm run benchmark:stage:100:safe
```

Larger single stages are available with:

```bash
npm run benchmark:stage:1000
npm run benchmark:stage:5000
npm run benchmark:stage:10000
```

The multi-stage helper exists too:

```bash
npm run benchmark:stages:mvp
```

That helper is cumulative inside one fresh run: stage `1000` adds `900` new feeds after stage `100`, stage `5000` adds `4000`, and so on. If you want every stage to start from an empty database, reset the benchmark stack between runs.

## Defaults

- API host port: `${BENCHMARK_API_HOST_PORT:-3400}`
- PostgreSQL host port: `${BENCHMARK_POSTGRES_HOST_PORT:-57432}`
- Redis host port: `${BENCHMARK_REDIS_HOST_PORT:-58379}`
- Fixture host port: `${BENCHMARK_MONITORING_PORT:-4110}`
- Default stage list: `100`
- Default artifact root: `artifacts/benchmark/`

Optional overrides:

- `BENCHMARK_STAGES=100,1000`
- `BENCHMARK_BATCH_SIZE=50`
- `BENCHMARK_TIMEOUT_MS=300000`
- `BENCHMARK_SAMPLE_LIMIT=10`

## What a completed stage proves

- The API accepted the requested feed registrations.
- The worker fetched the expected number of deterministic RSS feeds.
- The ingestion path persisted entries and generated alerts for the newly seeded feeds.
- The webhook notifier delivered the same number of alert payloads to the local fixture.

The harness is intentionally conservative for the first run. Start with `100`, inspect the artifacts, then scale up.

## Reading the published chart

[`benchmark-scaling-chart.svg`](./benchmark-scaling-chart.svg) is the result of one local
run covering the `100, 1000, 5000, 10000` stages. It records total wall time growing as
roughly `O(n^0.55)` and per-feed costs of `21.66 → 53.53 → 2.24 → 5.75 ms/feed`.

Two caveats matter when quoting those numbers:

- The feeds are served by the deterministic local fixture in `scripts/smoke`, not by the
  live internet. The chart measures the ingestion pipeline — queue, fetch, parse, dedupe,
  match, persist — with network variance removed on purpose.
- It is a single run on unspecified hardware. Absolute milliseconds are machine-dependent
  and do not transfer; the exponent and the shape of the curve are what the run evidences.
  Re-run the stages on your own machine before comparing.
