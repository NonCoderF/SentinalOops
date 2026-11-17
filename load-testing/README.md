# SentinelOops Load Testing

This module is a manually launched, localhost-only HTTP load generator for the existing `test-service`. It does not run automatically and does not add a Docker Compose service.

## Target

The default target is `http://localhost:8080/`, which is an implemented route in `apps/test-service/src/app.ts`. Targets are rejected unless they use HTTP and resolve to `localhost`, `127.0.0.1`, or `::1`.

## Commands

Run from the repository root:

```powershell
npm run loadtest -- smoke
npm run loadtest -- benchmark --vus=20 --rate=250
npm run loadtest -- stress --vus=50 --rate=500 --yes
npm run loadtest -- billion --vus=100 --rate=1000 --yes
npm run loadtest -- stop
npm run loadtest -- report
```

The billion command is only a configuration for a cumulative request target; it is never started automatically. Tests over one million requests require either typing `RUN` at the confirmation prompt or passing `--yes`. Start with the smoke command and increase deliberately.

Useful controls:

```text
--total=N                 request target
--vus=N                   concurrent virtual users, capped at 500
--rate=N                  aggregate request rate
--duration=SECONDS        optional duration limit
--timeout-ms=N            per-request timeout
--failure-threshold=0.05  stop after the failure ratio exceeds this value
--latency-limit-ms=2000   stop after a request exceeds this limit
--unavailable-limit=20    stop after sustained target failures
--target=http://localhost:8080/
--yes                     confirm a large test non-interactively
```

Press Ctrl+C or run `npm run loadtest -- stop` from another terminal for an emergency stop. Reports are written to `load-testing/reports/latest.json` and `load-testing/reports/latest.md`.

## Prometheus and Grafana

While a test is running, the host process exposes aggregate metrics at `http://localhost:9464/metrics`. Prometheus has a separate `sentinelops-load-test` scrape job targeting `host.docker.internal:9464`. The Grafana load-testing dashboard displays request rate, total requests, error rate, latency percentiles, active virtual users, and progress.

The metrics use bounded labels: scenario, result, and status code. There is no per-request database record or request ID label.

## Safety

- Only local targets are accepted; external hosts and third-party APIs are rejected.
- Concurrency and request rate are bounded by command-line options.
- Large tests require explicit confirmation.
- Tests stop on excessive failures, slow responses, sustained unavailability, low host memory, duration expiry, Ctrl+C, or the stop command.
- The full billion-request experiment is not run as part of setup or validation.
- Resource samples are process/host observations gathered periodically; they are not a substitute for a full infrastructure profiler.

## Scaling experiments

Use the scenario option to label comparable runs when the service is later deployed with different replica counts:

```powershell
npm run loadtest -- benchmark --scenario=one-replica --total=100000 --rate=200
npm run loadtest -- benchmark --scenario=three-replicas --total=100000 --rate=200
```

Kubernetes and load-balancer deployment are not implemented by this module.
