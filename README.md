# SentinelOps — four-container architecture

The root Compose stack runs exactly four SentinelOps containers:

1. `test-service`
2. `prometheus`
3. `grafana`
4. `alert-manager`

The Alert Manager image contains the Fastify API, React/Vite build, SQLite database, Prometheus polling loop, durable SQLite job queue, notification worker, SMTP delivery, incident history, and recovery-state tracking.

## Start

Set the existing Grafana password in the root `.env` file:

```dotenv
GRAFANA_ADMIN_PASSWORD=choose-a-password
```

Then run from the SentinelOps root:

```powershell
docker compose up -d --build --remove-orphans
docker compose ps
```

URLs:

- Alert Manager: http://localhost:3005
- Test service: http://localhost:8080
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3000

SQLite and queued jobs persist in the `sentinelops_data` volume. Prometheus and Grafana retain their existing volumes.

## Detection design

Prometheus v2.55.1 does not provide a native arbitrary webhook receiver for alert rules. Alertmanager is therefore intentionally removed from this four-container design. Alert Manager polls Prometheus's supported `/api/v1/alerts` endpoint every two seconds.

- Prometheus evaluates rules every 2 seconds.
- Alert Manager treats firing Prometheus alerts as FIRING incidents.
- A previously firing fingerprint missing from the next active-alert response becomes RESOLVED.
- Notification jobs are persisted in SQLite before SMTP processing.
- Jobs retry with bounded backoff and become failed after three attempts.
- Repeated fingerprints update one incident instead of creating duplicates.

## SMTP

Open http://localhost:3005 and select Email settings. Configure a real SMTP provider. For Gmail use:

- Host: `smtp.gmail.com`
- Port: `465`
- SSL/TLS: enabled
- Username: your Gmail address
- Password: a Google App Password, not your normal password
- Sender and one or more recipients

Credentials are encrypted using `SETTINGS_ENCRYPTION_KEY`, are never returned to the browser, and are not logged. Enable notifications, save, then use Send test email.

## Outage demonstration

```powershell
docker compose stop test-service
```

Wait approximately 15–25 seconds. The ServiceDown rule will become active and the Alert Manager dashboard will show one active critical incident. Configure SMTP first if you want the FIRING email.

Recover:

```powershell
docker compose start test-service
```

After another polling cycle, the incident becomes RESOLVED and the recovery email is queued.

## Validation

```powershell
docker compose config --services
docker compose config --quiet
npm test
docker compose exec -T prometheus promtool check config /etc/prometheus/prometheus.yml
docker compose exec -T prometheus promtool check rules /etc/prometheus/alert-rules.yml
```

The old Kafka, PostgreSQL, Alertmanager, legacy receiver, and separate frontend containers are no longer started by the root Compose file. Their prior named volumes are not deleted automatically; they can be removed manually later only if you no longer need their historical data. Kafka and PostgreSQL are not used in the four-container architecture.
## Browser refresh behavior

Prometheus's 2-second `scrape_interval` controls collection on the server; it does not refresh the Prometheus expression browser automatically. The native Prometheus UI is intended for manually executing queries. Keep the Prometheus tab open for inspection, but use Grafana for an automatically refreshing dashboard. The supported native alternative is to re-run the query (or use a browser extension), because this project does not replace or modify Prometheus's built-in UI.

Grafana is provisioned with a 2-second minimum refresh interval, a dashboard default refresh of `2s`, and `2s` in the dashboard refresh menu. Open `http://localhost:3000`, select the `SentinelOps — Service Monitoring` dashboard, and leave the refresh control enabled at `2s`. Grafana will query Prometheus automatically while the tab is active. Browsers may throttle timers and network activity in background/inactive tabs; this is a browser safety behavior and cannot be reliably disabled by the application. When the tab becomes active again, Grafana resumes its refresh cycle.

The Alert Manager UI at `http://localhost:3005` uses an in-process SSE stream at `/api/events/stream` for immediate incident and notification updates, with a 10-second snapshot fallback after reconnects.
