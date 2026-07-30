# FeedPulse documentation

Living documentation for the FeedPulse codebase. Every page here is written against the
code in this repository, not against a plan for it. If a page and the code disagree, the
code is right and the page is a bug.

## Start here

| Document                               | What it answers                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| [`architecture.md`](./architecture.md) | How the three runtimes, the ten modules and the ports-and-adapters layout fit together. |
| [`api.md`](./api.md)                   | The HTTP contract: every route, envelope, filter and error code.                        |
| [`database.md`](./database.md)         | The PostgreSQL schema as `db/migrations/0001..0021` actually builds it.                 |
| [`testing.md`](./testing.md)           | Which suite runs where, and exactly what `pg-mem` can and cannot do.                    |

## Operations

| Document                                           | What it answers                                                |
| -------------------------------------------------- | -------------------------------------------------------------- |
| [`local-smoke.md`](./local-smoke.md)               | Running the deterministic full-stack smoke flow locally.       |
| [`local-benchmark.md`](./local-benchmark.md)       | Running the feed-capacity benchmark, from 100 to 10,000 feeds. |
| [`deployment-dokploy.md`](./deployment-dokploy.md) | Deploying the Compose stack to a single VPS through Dokploy.   |

## Decision records

Short records of the choices a reviewer is most likely to ask about. Each one states the
context, the decision, and what it costs.

| ADR                                                 | Decision                                                |
| --------------------------------------------------- | ------------------------------------------------------- |
| [0001](./adr/0001-raw-sql-migrations.md)            | Raw SQL migrations instead of an ORM migration tool.    |
| [0002](./adr/0002-bullmq-over-cron.md)              | BullMQ and a claim loop instead of cron.                |
| [0003](./adr/0003-canonical-link-alert-dedupe.md)   | One alert per article, keyed on a canonical link.       |
| [0004](./adr/0004-per-channel-delivery-tracking.md) | Per-channel delivery state on the alert row.            |
| [0005](./adr/0005-single-error-envelope.md)         | A single flat error envelope for every failing request. |

## Generated artefacts

| File                                                             | How it is produced                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| [`openapi.json`](./openapi.json)                                 | `npm run docs:openapi` — dumped from the running API. |
| [`benchmark-scaling-chart.svg`](./benchmark-scaling-chart.svg)   | Rendered from a local capacity benchmark run.         |
| [`benchmark-scaling-chart.html`](./benchmark-scaling-chart.html) | Interactive version of the same chart.                |

`openapi.json` is committed so that a pull request changing a route, a DTO or a response
envelope shows the contract change in its own diff. Regenerate it whenever you touch a
controller or a DTO.

## Archive

[`archive/PRD-es.md`](./archive/PRD-es.md) is the original product brief the project
started from, kept for history. It describes the intended MVP, not the system that exists
today; read it as a snapshot of the starting point, never as a specification.
