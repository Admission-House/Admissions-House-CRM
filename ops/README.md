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

## 6. Known limits (be honest with the client)

* Rate limiting is in memory, per API process. With several containers each has its own counters.
  Move it to Redis when running more than one container behind a load balancer.
* Uploaded files are scanned only for type (by their bytes) and active content in PDFs. There is no
  antivirus. Add ClamAV if students will upload files from anywhere.
* Uploads live on the local disk by default. Set `STORAGE_DRIVER=s3` (see below) to use an S3
  compatible bucket instead.
* No automatic database failover. Use a managed PostgreSQL with point-in-time recovery if you need it.
* Recordings are downloaded from the provider's address into private storage; how the provider
  authorises that download is not yet known.

## 7. Load test

`pnpm --filter @ah/api load-test` starts the API against the development database with a throwaway
company and prints requests per second and latency for the main endpoints. Run it on the same kind
of machine as production before launch, and again after large changes.
