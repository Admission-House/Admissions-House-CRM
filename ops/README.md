# Running Admissions House CRM in production

This is the checklist for the person who deploys and looks after the server. The Docker image, the compose stack, the migration job, provisioning a company and signing in were
tried on a developer machine (Docker Desktop) and worked. They have not been run on a real server
with HTTPS, a real mail server or real traffic: do a trial deployment before real data goes in.

## 1. What runs where

| Part | What it is | Notes |
| --- | --- | --- |
| API | `apps/api`, Node 24, one container | Stateless apart from the uploads folder. |
| Database | PostgreSQL 18 | The only place data lives, apart from uploads. |
| Uploads | A folder (`STORAGE_DIR`) or S3 | Documents and call recordings. Private, never served by a web server directly. |
| Reverse proxy | Caddy, nginx or a cloud load balancer | Terminates HTTPS. The API must not be reachable without it. |

The API runs background jobs inside the same process (idle sweep, follow-up reminders, intake retry,
lead imports, recording downloads). They take database locks, so running two API containers is safe,
but each job still runs once at a time.

## 2. Secrets and settings

Create `.env.production` next to `docker-compose.yml`. Generate every secret; never reuse one.

```
OWNER_DB_PASSWORD=...            # the database owner, used only by the migration job
APP_DB_PASSWORD=...              # the restricted role the API uses
JWT_ACCESS_SECRET=...            # 32+ random characters
DATA_ENCRYPTION_KEY=...          # 64 hex characters: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CORS_ORIGINS=https://crm.example.com
WEB_URL=https://crm.example.com
TRUST_PROXY_HOPS=1               # how many proxies sit in front, so client addresses are real
MAIL_DRIVER=smtp
SMTP_HOST=...  SMTP_PORT=587  SMTP_USER=...  SMTP_PASSWORD=...
MAIL_FROM="Admissions House CRM <no-reply@yourdomain>"
```

Back up `DATA_ENCRYPTION_KEY` somewhere safe and separate. Without it, stored telephony credentials
and employee bank details cannot be read, and a database backup alone is not enough to recover them.

The API refuses to start in production with the log mail driver or a database owner account in
`DATABASE_URL`.

## 3. First deployment

Ready-made files in this folder: `production.env.example` (every setting, copy it to `../.env.production`) and `Caddyfile` (HTTPS in front of the web CRM and the API; send `/api/v1/*` straight to port 3001 and everything else to port 3000).


```
docker compose --env-file .env.production up -d --build
docker cp company.json <api-container>:/app/company.json
docker compose --env-file .env.production exec -e MIGRATOR_DATABASE_URL=postgres://ah_owner:<OWNER_DB_PASSWORD>@db:5432/admission_house api node db/provision-tenant.mjs /app/company.json
docker cp <api-container>:/app/.secrets/<slug>.txt .   # first-time passwords; share them, then delete the file
```

The migration job runs before the API on every deployment and is safe to run again.

## 4. Backups and restore

`ops/backup.sh` writes a compressed database dump and an archive of the uploads, checks the dump can
be read, and deletes copies older than `KEEP_DAYS`. Schedule it nightly and copy the folder off the
machine (another server or object storage). A backup kept only on the same disk is not a backup.

Restore into an empty database:

```
createdb admission_house_restore
pg_restore --no-owner --dbname=admission_house_restore db-YYYYMMDD-HHMMSS.dump
tar -C /path/to/storage -xzf files-YYYYMMDD-HHMMSS.tar.gz
```

Then run the migration job once (it recreates the restricted role and its rights) and start the API.
**Practise a restore before you need one.** A restore you have never tried is a guess.

## 5. Watching it

* `GET /api/v1/health/live` says the process is up; `GET /api/v1/health/ready` says the database
  answers. Point the load balancer at `ready` and the container health check at `live`.
* Logs are JSON, one line per request, with a request id. The error body shown to a user carries the
  same id, so a complaint can be traced to a log line.
* Failed lead deliveries and call events are kept in `inbound_events` with status `failed` and the
  reason; Integrations in the admin area lists them and can retry.
* **Live updates (WebSocket).** Screens (the bell, the team view, the dashboard, the queue counts) change at
  once instead of waiting for their timer. The browser connects to `wss://<web address>/api/v1/ws`, so
  **the reverse proxy must pass WebSocket upgrades** for `/api/v1/*` to the API (Caddy and most cloud load
  balancers do this by default; nginx needs `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";` and a read timeout above 60 s). If the proxy does not, nothing
  breaks: screens simply keep refreshing on their timers. The database tells the API servers what changed
  through `LISTEN/NOTIFY` (migration 030), so several API containers need no broker. What is sent is only
  a hint ("a notification came", "the team changed"); the browser then asks the normal API for the numbers,
  so no data travels on the socket. `REALTIME_ENABLED=false` switches it off; `REALTIME_RECHECK_SEC`
  (default 60) is how soon a signed-out person's connection is closed. On a developer machine the page
  (port 3000) connects straight to the API (port 3001); set `NEXT_PUBLIC_WS_URL` to override.
* **Metrics.** Set `METRICS_TOKEN` (16 or more random characters) and a monitoring tool (Prometheus,
  Grafana Cloud, Datadog, and so on) can read `GET /api/v1/metrics` with `Authorization: Bearer <token>`.
  Without the token the address does not exist. Requests are counted by route pattern
  (`/api/v1/leads/:id`), never by the real address, so no lead id or phone number is in a metric.
  Prometheus example:

  ```
  scrape_configs:
    - job_name: ah-api
      metrics_path: /api/v1/metrics
      authorization: { credentials: <METRICS_TOKEN> }
      static_configs: [{ targets: ['crm.example.com'] }]
  ```

  Alerts worth setting (tune after a week of real traffic):

  | Alert | Expression |
  | --- | --- |
  | Slow | `histogram_quantile(0.95, sum by (le) (rate(ah_http_request_duration_seconds_bucket[5m]))) > 0.5` for 10 minutes (the agreed target is 0.5 s) |
  | Errors | `sum(rate(ah_http_requests_total{status=~"5.."}[5m])) / sum(rate(ah_http_requests_total[5m])) > 0.02` for 5 minutes |
  | Database pool full | `ah_db_pool_waiting > 0` for 2 minutes (raise `DB_POOL_MAX` or look for slow queries) |
  | Down | the monitor cannot reach `/api/v1/health/ready` for 2 minutes (use an outside uptime check as well) |

  The metrics are numbers only. They do not send a message to anyone: connect the alerts to email,
  WhatsApp or a phone call in the monitoring tool, and decide who is on call (question H6 in the
  client questions).

## 6. Known limits (be honest with the client)

* Rate limiting is in memory, per API process. With several containers each has its own counters.
  Move it to Redis when running more than one container behind a load balancer.
* Uploaded files are checked for type (by their bytes) and active content in PDFs, and, when
  `CLAMAV_HOST` is set (the compose file starts a `clamav` container and sets it), scanned by ClamAV
  before they are kept. If the scanner is down, uploads are refused (503) rather than let through.
  Without `CLAMAV_HOST` there is no antivirus.
* Uploads live on the local disk by default. Set `STORAGE_DRIVER=s3` (see below) to use an S3
  compatible bucket instead.
* No automatic database failover. Use a managed PostgreSQL with point-in-time recovery if you need it.
* Recordings are downloaded from the provider's address into private storage; how the provider
  authorises that download is not yet known.

## 6b. Telephony with Exotel

Settings → Telephony → provider `exotel`. Exotel cannot send headers or sign its callbacks, so the
company's webhook key is the last part of the callback address
(`/api/v1/telephony/hooks/exotel/<key>`); the API removes it from its logs. For incoming and missed
calls, add a Passthru applet (method GET) to the incoming-call flow pointing at the same address.
Exotel's `YYYY-MM-DD HH:mm:ss` stamps are read as India time (+05:30); confirm on the first real call.

## 7. Load test

`pnpm --filter @ah/api load-test` starts the API against the development database with a throwaway
company and prints requests per second and latency for the main endpoints. Run it on the same kind
of machine as production before launch, and again after large changes.
