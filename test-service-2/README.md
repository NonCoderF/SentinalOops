# SentinelOops Test Service 2

Independent second demo workload used to test multi-service monitoring and sequential recovery.

## Endpoints

- `GET /api/health`
- `GET /api/catalog`
- `GET /api/orders`
- `GET /metrics`

## Docker

From the repository root:

```powershell
docker compose -f test-service/docker-compose.yml up -d --build test-service-2
```

The service is available at `http://localhost:8081` and runs as `sentinelops-test-service-2`.
