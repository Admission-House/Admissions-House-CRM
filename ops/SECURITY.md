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
| Calls and meetings | Voice calls, video calls and group meetings run on Agora. The App Certificate stays on the server and makes join tokens that last 5 minutes and are renewed only while the person is still allowed in, so ending a session or removing someone takes effect within moments even for a screen left open. An outside guest has an invitation of their own: its link is an HMAC of the invitation and its version (nothing secret is stored), expires, is cancelled by raising the version, works from the first device only (a random value the browser keeps; the host can release it), and opens that one session and nothing else. Wrong or cancelled links answer a plain 404 and repeated bad guesses are slowed. Who may see, start, end or remove people is decided on the server from the existing roles: the people in a session, whoever started it, whoever oversees them, and whoever may see its lead; ending or removing needs the host or `comm.manage`. The trail of events (invited, ringing, joined, left, removed ...) cannot be changed by the application role. **Not in this version: recording, and a consent notice** (they come with Agora Cloud Recording, which needs a storage bucket and a decision on consent and retention). Rotating `JWT_ACCESS_SECRET` invalidates guest links already sent. |
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
