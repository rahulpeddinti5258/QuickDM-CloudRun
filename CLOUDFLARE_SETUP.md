# QuickDM on Cloudflare

The Worker implements comment private reply → public comment reply → button or DONE → follower check → resource button. The Python application remains available for the existing Mac setup. The Worker uses the same Instagram account, API host, public reply text and resource URL.

## Local checks

Use Node 24 or later and Python with the existing requirements installed.

```sh
npm ci
npm test
python3 -B -m unittest discover -s tests -v
npx wrangler deploy --dry-run
```

Tests include a local Cloudflare runtime with D1 and Queues. Outbound Meta calls are mocked or simulated. Runtime tests need permission to listen on localhost.

## First staging deployment

The default configuration uses simulation mode. Create a free D1 database named `quickdm-staging` and queue named `quickdm-staging-events` in this Cloudflare account. Set `database_id` in `wrangler.jsonc` to the actual D1 ID. Apply the schema before accepting events.

```sh
npm run db:migrate:remote
```

Configure `VERIFY_TOKEN` and `META_APP_SECRET` privately as Worker secrets. Use test-only values for simulated staging. A live deployment also needs `INSTAGRAM_ACCESS_TOKEN`. Never put secrets in Git, screenshots, build commands, or chat.

Cloudflare Git build settings should point at branch `codex/reliable-quickdm`, root directory `/`, project name `quickdm-staging`, build command `npm ci && npm test`, and deploy command `npx wrangler deploy`. This branch must be pushed before it appears in the selector. Review whether runtime tests can open localhost in the Cloudflare build environment.

The generated Worker URL has webhook path `/webhook` and liveness path `/healthz`. A liveness response only confirms that the Worker responds. Signed webhook tests must separately verify database and queue readiness. A valid event is acknowledged after D1 storage. If queue dispatch fails, the scheduled handler retries pending records every five minutes.

## Account capability checks before production

Keep the production callback on its current target until controlled checks succeed. Required checks are initial private-reply button eligibility on this integration and API version, matching the returned `recipient_id` to the subsequent messaging sender, receiving postback events with message IDs, and a boolean `is_user_follow_business` response for a consenting test user. Confirm subscriptions for comments, messages and messaging_postbacks and the appropriate app secret for webhook signatures.

The runtime requires both `FOLLOW_CHECK_VERIFIED=true` and `INITIAL_BUTTON_VERIFIED=true` for live acceptance. These are operator attestations after real checks, not automatic verification. Documentation support alone is insufficient to set them. Verify the default `v26.0` against the existing account before changing versions.

Use a separate D1 database and queue for production. The database records its simulation/live mode and rejects a mode switch, so simulated delivery records cannot silently suppress production delivery. For production, bind the fresh database and queue, apply migrations, privately configure the real secrets, set `DRY_RUN=false`, and set the verification flags only after the controlled checks. Never connect production Instagram traffic to the simulated staging endpoint.

## Preserve existing processed comments

With the local sender stopped during the agreed cutover window, export a consistent final snapshot of its database. The exporter opens the source read-only and retains all reservations, including incomplete ones. Run on the actual working public-reply database.

```sh
python3 scripts/export_legacy.py /Users/rahulpeddinti/QuickDM-PublicReply/quickdm.db .local/legacy-import.sql
npx wrangler d1 execute quickdm-production --remote --file .local/legacy-import.sql
```

Change the database name in the import command to the production database when using a separate name. Verify imported row counts before cutover. Incomplete legacy records are suppressed for manual review because their external send outcome may be unknown.

## Delivery guarantees and recovery

Events, action claims and workflow progress live in D1. Concurrent consumers claim work with conditional SQL updates. Confirmed initial sends are reused when retrying public replies. A timed-out send or ambiguous 5xx result becomes `unknown` and requires review. A timed-out worker with a `sending` action also requires review. This conservatively avoids blindly repeating a potentially successful message, but can require human intervention for undelivered messages.

Rate-limited sends retry with bounded backoff. Unknown follower status produces a limited explanatory message and retries, then puts the event in review after eight attempts. The user can tap again. A false result sends the follow prompt and permits another attempt. Link delivery is keyed by sender, media and resource, allowing future reels while suppressing repeated deliveries for the same resource on the same reel. DONE with multiple pending comments asks the user to tap the relevant original button.

Inspect records with `status='review'` in `events` and `status IN ('unknown','failed')` in `actions` through the private D1 console. Confirm actual Instagram outcomes before resolving or replaying them. The implementation provides no public admin/reset endpoint. Back up D1 before manual maintenance.

A rollback requires reconciling cloud delivery history into the previous sender's deduplication store. Simply restarting a stale local database can resend old work. Retain event/action records throughout migration and rollback.

## Free-plan limits to validate

Test real CPU usage against the free Worker budget and monitor D1 rows read/written and queue operations. Every queue delivery and retry consumes operations. The recovery scheduler dispatches at most ten due records per run. At high backlog or retry volume, quotas can be exhausted. D1 stores events so queue retention expiry can be recovered later, within Meta's messaging eligibility windows. No free-capacity or uninterrupted-delivery guarantee has been established by local tests.

The SQLite `DatabaseSync` wrapper tests SQL transitions, and Miniflare tests local D1/queue integration. Remote D1 concurrency, actual CPU measurements, hosted signature checks, and real Meta behavior remain deployment acceptance tests.

## Current setup status

The `quickdm-staging` D1 database has been created in the connected Cloudflare account; its ID is committed in the binding configuration (this ID is not a credential). The default Worker and queue names explicitly identify staging. Live secrets and the Instagram webhook have not been changed.
