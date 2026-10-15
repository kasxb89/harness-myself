# Credits host

The credits host relays the local product's account, balance, recharge, and media operations through the origin-checked `/credits` routes. Its HTTP carrier is [webserver](../webserver/README.md). Credentials remain in the host's existing account session and credential files.

## Usage analysis

`GET /credits/api/usage?start=<seconds>&end=<seconds>` returns the signed-in account's hourly model aggregates. Both parameters are inclusive positive Unix-second integers; the complete interval may contain at most 31 days. The client chooses its display timezone before converting natural days to seconds. Duplicate parameters, account selectors, and other query parameters are rejected.

Success uses the credits envelope `{ ok: true, payload: ... }`. The payload contains `rows`, `start`, `end`, `asOf` (ISO time of the read), and `delayMinutes: 5`. Each row contains `timestamp` (Unix seconds), `model`, `billingRecords`, `consumedPoints`, and `totalTokens`. Billing records include charge adjustments and must not be described as request counts. Consumed points represent recorded charges without subtracting refunds. Token totals have no input/output split. Empty rows mean the enabled source successfully returned no records for the interval.

The host verifies the upstream user ID against the current product session before reading `/api/data/self`. A lapsed upstream credential can fall back to the existing read-only admin token: the host finds the exact session account ID, then reads `/api/data/` with that account's exact username. Only a legacy session lacking a valid positive integer ID can resolve its account through one exact, unique `phone_e164` match; the resolved ID remains local to the read. An upstream token for another ID is rejected. The admin's own usage is never used. This read neither writes credentials nor changes the balance, login, recharge, or billing flows.

One successful `/api/status` read supplies `quota_per_unit` and `usd_exchange_rate` for every row in the response. Points use `quota / quota_per_unit × usd_exchange_rate × creditsPerYuan` without integer rounding. Missing or invalid conversion settings, disabled collection, unavailable credentials, invalid source records, and service failures return `{ ok: false, code, message }` without partial rows or a replacement zero. HTTP 403 is reported as `USAGE_ACCESS_DENIED` when no authorized same-account fallback succeeds; upstream credential and permission details are not exposed. The receiving client owns visible error reporting and retry; the host preserves the account and balance after read failure.

The route shares the existing local-origin guard, configured `timeoutMs`, `newApiBaseUrl`, `creditsPerYuan`, and `newApiAdminTokenFile`. An empty admin-token path resolves to `../credentials/newapi-admin-read-token` relative to the credits state directory. Remote platforms do not have a usage fallback.

## Model Experience

Usage analysis is a browser-only read. It adds no model input, output, token use, or KV-cache state.

## Known Limitations and Deferred Work

The source groups records by hour and normally flushes them every five minutes. These aggregates cannot provide exact request timestamps, refund-adjusted net spending, per-token direction, or a live balance ledger. Usage responses are capped at 100,000 source rows; exceeding the cap is a visible failure.
