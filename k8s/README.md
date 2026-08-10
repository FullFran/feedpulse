# Kubernetes deployment

Manifests for running FeedPulse's three runtimes on Kubernetes. Tracking issue:
[#15](https://github.com/FullFran/feedpulse/issues/15).

## Why Kubernetes, honestly

At the volume this project currently runs, Kubernetes is **not** the cheapest or
simplest option. The existing `compose.dokploy.yml` is. Anyone claiming
otherwise is selling something.

What Kubernetes buys here is specific and measurable:

| Capability | Why Compose cannot do it |
|---|---|
| Scale `worker` on **queue depth** | Compose has no autoscaler, and no way to read BullMQ backlog |
| Independent scaling per runtime | `api`, `scheduler` and `worker` have unrelated load profiles |
| Rolling updates with automatic rollback | Compose replaces containers; it does not gate on health |
| Declarative recovery | A node dying is rescheduling, not an incident |

The crossover point — the feed count above which this stops being overkill — is
measured in [#24](https://github.com/FullFran/feedpulse/issues/24) using
`npm run benchmark:stages:mvp`. The number belongs in the README, including the
range where Kubernetes loses.

## Layout

```
k8s/base/          Deployments, Service, ConfigMap, Ingress, migration Job
k8s/keda/          ScaledObject: worker autoscaling on BullMQ queue depth
k8s/monitoring/    ServiceMonitor / PodMonitor for kube-prometheus-stack
```

## Apply

```bash
kubectl create namespace feedpulse

# Secrets come from a secret manager, never from the repository.
# k8s/base/secret.example.yaml documents the required keys.

kubectl apply -k k8s/base
kubectl apply -f k8s/keda          # requires KEDA installed
kubectl apply -f k8s/monitoring    # requires kube-prometheus-stack installed
```

## The decisions worth knowing

**`scheduler` is a Deployment, not a CronJob.** It owns its own timing loop
(`SCHEDULER_TICK_MS`, default 15s) and holds warm database and Redis
connections. A CronJob would pay full process startup every tick for a 15-second
interval. It runs with `strategy: Recreate` so two schedulers never tick at
once; enqueue is deduplicated by job id (`feed-<id>`) so a brief overlap is
survivable, but a visible gap is easier to reason about.

**Liveness never touches a dependency.** `/health` is process-only; `/ready`
resolves the base schema. Wiring a dependency check into liveness converts a
Postgres blip into a cluster-wide CrashLoopBackOff, because every restarted pod
comes back to the same unreachable database.

**`terminationGracePeriodSeconds` must exceed `SHUTDOWN_TIMEOUT_MS`.** On
SIGTERM the runtime stops accepting jobs and drains the in-flight one. If the
kubelet SIGKILLs first, that job dies mid-flight and BullMQ only recovers it
once the lock expires.

**The worker Deployment declares no `replicas`.** KEDA owns that field. Setting
it here would fight the ScaledObject on every apply.

**Worker probes are TCP, and that is a known compromise.** The worker has no
HTTP API, only its metrics server. A TCP check proves the process is up and its
event loop accepts connections — it cannot prove the BullMQ connection is alive.
Closing that gap needs a readiness endpoint reporting consumer state.

**Migrations must be backward compatible.** During a RollingUpdate both versions
serve at once. Expand-and-contract; never a destructive change in the release
that also ships the code depending on it.

## Not done yet

- Terraform for the cluster itself ([#21](https://github.com/FullFran/feedpulse/issues/21))
- CI/CD deploy with automatic rollback ([#22](https://github.com/FullFran/feedpulse/issues/22))
- Grafana dashboards ([#20](https://github.com/FullFran/feedpulse/issues/20))
- Worker readiness reflecting consumer state
