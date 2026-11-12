# Security review: what is in place, and what is not

Written from the code, not from a penetration test. Nobody outside the project has attacked this yet;
hire that before taking other companies' data.

## In place

| Area | What the code does |
| --- | --- |
| Company separation | Every table has `tenant_id`; row-level security is forced and the API connects as a role that cannot bypass it. A company's id is set per transaction from the signed-in session, never from the request. |
| Sign-in | Argon2id hashes, lock after 5 failures, per-address limits, same answer for unknown and wrong accounts. Access token 15 minutes; refresh token rotates and its reuse ends the session. The session is checked in the database on every request. |
| Office rule | Network range **and** GPS radius for office roles; mobile devices are bound and approved. |
| Permissions | Closed by default (every route needs a permission unless marked public). Data scope (all, team, own) is applied in SQL. What a person may not see is a 404, not a 403. |
| Escalation | Nobody can grant a permission they do not hold; the last Super Admin cannot be removed. |
| Inputs | Every body and query is validated (zod). Errors have one shape and never include internals. |
| Uploads | Type is decided from the bytes, not the name. Only JPG, PNG, PDF (documents) and common audio (recordings). PDFs with scripts or auto-open actions are refused. Files are stored under server-made names, served with `nosniff`, `no-store` and a sandboxing CSP. Links to files are signed and expire. |
| Spreadsheets | Imports read bytes, not names; limits on rows, columns and size. Exports neutralise cells that begin with `=`, `+`, `-`, `@` so they cannot run as formulas. |
| Outbound fetches | Recording downloads only from hosts the company listed, https, no redirects, size and time limits, private addresses refused at connect time. |
| Secrets at rest | Telephony credentials and bank details are encrypted (AES-256-GCM, bound to their row). Webhook and API keys are stored only as hashes. Password reset links are random, single use, expire, and only a hash is stored. |
| Auditing | Logins, role and user changes, salary edits, exports, recording playback, bank-detail reveals, telephony changes are written to an append-only audit log. |
| Transport and headers | Helmet, strict CORS list, cookies httpOnly and path-limited. HTTPS must be provided by the proxy. |
| Dependencies | `pnpm audit` runs in CI at high severity. |
| Rate limits | Sign-in, reset, intake and webhooks; each signed-in user 600 requests/min, and 30/min for exports, imports, uploads and file downloads. Counted per process. |
| Document access | Opening a student document is written to the audit log (`document.view`). |
| History and erasure | The lead history table cannot be changed or deleted by the application role (migration 032). A Super Admin (`lead.erase`) can erase a student's personal data with `POST /leads/:id/erase`: name, e-mail, phones, profile, guardians, documents and recordings (files too), notes in history and the raw website payload. The anonymous lead row stays for the numbers. Import files already processed are not scrubbed by this. |
| Retention | Once a day each server clears sign-in attempts, finished website events (failed ones twice as long), ended sessions older than `RETENTION_KEEP_DAYS` (default 90) and used or expired reset links older than 30 days. Switch off with `RETENTION_INTERVAL_HOURS=0`. Business records and the audit log are never cleared. |
| Video counselling | Join tokens are made on the server with the Agora App Certificate (never sent to a browser) and last only as long as the session's agreed minutes. The student's link is an HMAC of the session id under the server secret: it opens that one session and nothing else, stops working when the session ends or expires, and is rate-limited per address. Rotating `JWT_ACCESS_SECRET` invalidates links already sent. Monthly minutes are capped by `VIDEO_MONTHLY_MINUTE_LIMIT` so the free package is not exceeded by accident. |
| Exotel credentials | Put in `.env` and applied with `pnpm telephony:connect <company>` (or the `connect-exotel` compose service). They are stored encrypted (AES-256-GCM, tied to the company), the Exotel webhook key only as a hash. The script never prints a secret; the address to give Exotel (it holds the key) goes to `.secrets/telephony-<company>.txt`, owner-only. Running it again keeps the key, so the address already given to Exotel keeps working. The running API never reads the `EXOTEL_*` settings, so after the step they can be removed from `.env`. |
| Search | Text search needs at least 3 letters. Name, email and phone search go through tenant-safe database functions (migration 025), because row-level security stops PostgreSQL using text indexes directly. |

## Not in place yet

1. **No outside security test.** Do one.
2. **Antivirus** runs on uploads only when `CLAMAV_HOST` is set (the compose file sets it). Without it there is none.
3. **Rate limits are per process** (in memory). Fine for one container; move to Redis for several.
4. **Two-step sign-in (TOTP) exists and a company can require it** (Settings > Security), but the mobile app cannot enter the code yet, so people covered by the rule use the web CRM only.
5. **No automated secret rotation.** Rotating `JWT_ACCESS_SECRET` signs everyone out; rotating
   `DATA_ENCRYPTION_KEY` needs a re-encryption script that does not exist yet.
6. **Audit log is append-only for the application role, but the database owner can still change it.**
   Ship it to a separate store if the client needs that guarantee.
7. **Recording playback has no range requests**, so seeking in long recordings downloads from the start.
8. **Backups are not encrypted** by `ops/backup.sh`. Encrypt the disk or the destination.

## Decisions a person should confirm

* A Super Admin or Admin cannot enter their own salary (someone else must).
* Any answered call from an unknown number does **not** create a lead; only a missed one does.
* "Idle" in the live team status means no activity for 10 minutes while signed in.
* A salary can be entered only for the current or an earlier month.
* A required custom field cannot be cleared, but is not forced when a lead is first created.
