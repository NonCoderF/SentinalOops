# SentinelOps test-service

An independent demo API used for integration checks. It does not depend on SentinelOps, Prometheus, Grafana, or any SentinelOps volume.

```bash
docker compose -f test-service/docker-compose.yml up -d --build
curl http://localhost:8080/api/health
curl http://localhost:8080/api/users
curl http://localhost:8080/api/products
curl http://localhost:8080/metrics
```

The Prometheus counter `sentinelops_http_requests_total` uses bounded `method`, `route`, and `status_code` labels. The route label is the registered route, never a raw URL or query string.
