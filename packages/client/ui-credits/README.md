---
description: "View account credits, sign in by phone, inspect usage, and insert workspace examples without submitting a request."
kind: "package-reference"
---

# Balance and usage

English | [中文](README.zh.md)

## Summary

View the current account's credits, sign in by phone, and inspect usage by day and model. Open the separate top-up panel when more credits are needed. Workspace examples help draft video requests without sending them or starting a billable operation. Usage reads the signed-in account's consumption billing records; recent charges may appear later.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Account, top-up and usage requests retain the application public mount through [`appPath`](../ui-primitives/README.md#use-this-package).

The balance panel displays the current account's credits, phone sign-in, and usage analytics. The separate top-up panel owns payment. Both panels share the existing session and balance store; usage queries use the signed-in account selected by the Credits host (`host/credits-index`).

The balance and phone sign-in page discloses statistics about signed-in Desktop client sessions, online presence and foreground use. These statistics exclude typed input, chat text, screen contents, local file paths and hardware fingerprints. Ordinary Web has no native activity sender.

The injected `creditsSession` source exposes that same account snapshot to sibling client plugins. Subscriptions retain the shared account refresh; the last release stops its timer and focus listener. Failed or malformed reads retain the last verified account and balance with a visible refresh error; null payloads never establish a successful read. Network interruption, timeout, sign-in, permission and rate-limit failures have separate guidance. Server retry delays disable repeated refreshes without clearing the login. When account validity is unknown, the balance page keeps Sign out available without enabling account-bound operations. Logout clears the displayed account only after the local Host confirms that no login remains. Failed confirmation preserves recovery controls; confirmed local logout with unconfirmed server revocation has separate guidance. The configurable `signOutTimeoutMs` bounds both logout and confirmation (default 20,000 ms; range 1,000–120,000 ms). An account change clears its old balance, and late reads cannot replace the current login's data.

The desktop welcome opens `?panel=credits` to select the balance panel and phone sign-in form. The client consumes this entry request once, removing only `panel` while preserving other query parameters and the hash. Opening the page does not create an account session or configure an API key. Successful phone verification refreshes the account session and returns to the existing conversation workspace without creating or clearing its Session, even when no registration reward is returned. Later balance and top-up selections, account refreshes and balance refreshes preserve the chosen panel.

The phone form distinguishes an invalid or expired code from a temporary sign-in outage. Failed requests keep their original request identity for a manual retry. Unknown SMS delivery preserves the challenge when available: the user can enter a received code or check the same request, without another dispatch. Only an explicit `not_sent` delivery receipt permits a new SMS key after another click; an unavailable response without delivery data keeps the original key and reports an unconfirmed result. Server cooldowns use absolute deadlines; remounting restores pending request identities without storing the code or submitting a request. Challenge expiry keeps an unconfirmed exchange available for manual recovery with the original code; the API decides whether its successful-response replay is still available. When the API declares `2fa`, the form accepts an authenticator or backup code; other methods remain unsupported. An unconfirmed security-verification result requires fresh phone authentication and is never replayed.

The phone form defaults to mainland China (`+86`) and offers 206 geographical calling codes covering 245 countries and regions from pinned Google libphonenumber metadata. Shared calling codes appear together without guessing a country from the code; the full international-number entry remains available. Canonical international numbers retain all entered digits. Known local trunk-zero prefixes require explicit user correction, while significant zeros such as Italy’s remain part of the number; complex or unknown national transformations are not guessed. An overseas challenge prepares sign-in without claiming SMS delivery or whitelist membership. Overseas users enter the private code first supplied through the operator on WeChat. The form accepts a 16-digit fixed code or an existing six-digit temporary code; mainland SMS remains six digits. Overseas codes are masked and declare autofill off; mainland SMS retains its text input and one-time-code hint. This adds no password-enrollment flow or persistent code storage. A fixed code can be reused until the operator resets or disables it, while temporary codes retain their expiry and single-use rules. A new challenge uses the same fixed code; challenge expiry does not imply code expiry. Unconfirmed exchanges first recover with the original request identity. Editing the phone or calling code clears the previous form challenge and code; only an explicit action submits a request. Phone numbers and login codes remain pasteable; the client never retrieves an operator code.

### Top-ups

Top-ups accept positive whole-yuan amounts and display the host's converted points, never upstream quota. Creating an order displays its WeChat QR and polls that order until a terminal response. A failed read preserves the QR and balance, explains that payment is unconfirmed, and offers another status read without creating a second order. Stopping checks aborts the active HTTP read without cancelling the payment. An unrecognized payment status stops automatic reads, remains visibly unconfirmed, and keeps the same order available for another status check. Replacing the order, changing accounts, or closing the panel discards late responses. Confirmed payment starts a new balance read instead of sharing a read started before payment; earlier responses cannot replace it. Server cooldowns and account isolation still apply, and a failed balance read leaves the confirmed payment visible.

The displayed account and its verified login owner bind every new order and status read. Confirming an amount first refreshes the shared session; discovering a different account or login clears the old QR and requires another explicit confirmation for the newly displayed account. An identity mismatch offers Refresh account details; uncertain ownership disables order creation. Older Hosts can still supply ordinary balance reads, but top-ups require the login-owner contract. Server retry delays also disable financial actions, and a failed or unconfirmed order submission is never retried automatically.

Below the top-up form, a bounded, wheel-scrollable grid shows one card per public reference model: four columns on desktop, two or one on narrower screens. Each card names one priced specification rather than implying a category-wide discount or account availability. Selecting a card opens its full same-specification prices, source, conditions and check date in a scrollable modal with shared keyboard dismissal and return focus. Comparisons use default platform prices, independently of the recharge amount or the current account’s final quote. Input and output remain separate; decimal arithmetic rounds discount claims conservatively. Missing official metadata and older Hosts produce no promotional claim. Account changes close old details and discard late reads; local read failures do not affect payment or generation.

### Registration survey

Only a current account's server-confirmed pending enrollment opens the use-case survey after phone registration. Existing accounts, deferred surveys and submitted surveys do not open automatically. Users can select multiple scenarios and optionally add up to 1,000 Unicode characters. Later closes the dialog without blocking the product, and a wallet entry resumes a deferred questionnaire. Submitted surveys remain complete across devices according to the API record; the client never infers new registration from local first use or a bonus.

The survey helps users get more from the product. The API configures up to 64 scenarios, their order and their Chinese and English labels; no client release is needed to change them. A configuration change preserves the draft and visibly retains unavailable choices until users remove them. Only another explicit reviewed submission sends the current revision. Completed answers retain their submitted configuration, and older APIs keep their original nine-option survey.

A root-owned controller outlives the sign-in page and clears drafts and late responses when account ownership changes. An unconfirmed submission first queries the current account's canonical survey; if that read also fails, it keeps the exact draft locked until an explicit recheck. Closing that dialog retains a working wallet entry and does not repeat the submission. An older Host or API without survey support leaves ordinary sign-in and use available.

### Usage analytics

Today, seven-day and thirty-day periods use Asia/Shanghai calendar days through the query time. A model filter applies to the consumption, billing-record and token totals, daily trend, model ranking and equivalent detail tables. A failed refresh keeps the last successful values for the same period and marks them as an earlier reading. Rate-limit responses show the server's retry delay and disable refresh and period changes until it expires. Changing the period clears the previous values while loading. Account changes unmount the previous account's analysis, and late responses cannot replace the current selection.

If a usage response belongs to another account or login, Retry first verifies the current shared session and then reads that identity's statistics. This recovers a change made in another window without repeatedly querying with the old panel identity. A new login for the same account also changes the local account epoch; an ordinary token refresh with the same login owner preserves it.

The charts represent reported cumulative charges before refunds, consumption billing records, and combined token usage. A successful complete response supplies zero-valued day buckets where no records exist. Empty responses show an empty state; unavailable, malformed or overflowing data produces a visible error without manufactured chart values. All labels, units and query-state messages follow the product locale and theme.

### Chat reply credits

The conversation composer shows Current chat reply credits, and each turn shows This turn’s reply credits. Both read verified receipts for the signed-in account and attached conversation through `/credits/api/chat-usage`; they never convert tokens into credits. The readings cover only recorded reply-model requests in the main conversation, excluding image/video tasks, separate AI writing, subchats, context compaction, automatic titles and other background helper calls. Confirmed details link to the balance usage records, which determine all consumption.

A precise amount appears only when the current read confirms every recorded request. Running or incomplete statistics show Calculating credits; missing receipts or failed reads show Statistics not ready. Neither the summary nor its details show partial amounts, request counts or a previous amount as the current total. Failures offer a concise refresh hint without suggesting insufficient balance or a top-up. HTTP 401/403 and denied access ask the user to sign in again.

The visible Refresh credits action and turn completion initiate reads; pending receipts with no confirmed bills get at most three follow-up reads. Other incomplete readings and failed or rate-limited reads require manual refresh. The client `chatUsageReadTimeoutMs` defaults to 20,000 ms and accepts 1,000–120,000 ms. Configure it above the owning Host's statistics deadline and network overhead; the Host defaults to 15,000 ms but deployments configure their own limit. Account changes, logout and closing the control abort reads and discard late results. The shared account snapshot’s in-memory epoch changes on identity transitions, including signing back into the same account, but stays stable during ordinary balance refreshes.

### Chat media preferences

The ordinary chat composer has one compact Creation preferences button. Its Image and Video tabs search authorized models and edit their declared static parameters. Switching tabs preserves both drafts; selecting the current model again retains its parameters, while selecting another model clears the prior model’s parameters. The explicit Clear parameters action resets the current model's parameters. Cancel discards drafts, and Save commits both choices with one owner- and revision-checked write. An unchanged unavailable choice remains visible without blocking changes to the other kind; only newly changed invalid parameters prevent saving. Reference files stay attached to individual requests, and video duration remains a single-clip default.

A private Host store preserves each account’s choices for its configured deployment across restarts. Startup restores only local preferences; the authorized model and price directory is read when users open the editor or explicitly recheck it. Failed saves retain both drafts. After rechecking a conflict, unedited choices adopt the latest acknowledgement while edited choices remain intact. Account changes clear the editor and discard late replies. Addressed subagent input does not show the settings entry.

Each ordinary submission captures acknowledged settings metadata before delegating to other prompt providers. Explicit model and parameter requests in that message take priority; otherwise personal settings precede platform defaults. Editing preferences affects later requests, while running and accepted generation keeps its original settings. Saving does not replace per-work video quotes or human confirmation. Ordinary text never waits for a media directory or balance request.

Prices appear only inside the editor, as estimated points per image or per second. The Host converts public retail prices with its configured point rate; the client compares decimal strings exactly and rounds displayed amounts upward to at most six decimal places. Complete specifications produce one value or a range; partial coverage and unknown pricing conditions show a starting value. Missing, malformed, wrong-unit or unsupported zero prices remain pending without blocking selection. These default public prices are references, not account-specific discounts, request totals or generation authorization; actual specifications and account quotes determine charges.

### Workspace guide

The signed-in conversation composer has a lightweight Workspace examples entry. It opens only at the user's request and explains natural-language video planning, generation within each model's clip limit, and trimming and joining generated or uploaded clips. This reference dialog is separate from the AI's request-specific clarification questions in chat. Escape, backdrop and close dismiss it. Only one examples dialog can be open across the client root's mounted conversations; changing accounts or releasing the composer closes it. Its state stays in memory, with no account acknowledgement or first-visit behavior.

Choosing an example inserts plain text at the captured selection's end, preserves existing text, reference chips and attachments, and never submits or starts a billable operation. A newer draft revision or busy composer refuses insertion and shows a notice; reopening the examples captures a fresh insertion position.

For a newly reported `INSUFFICIENT_BALANCE` chat failure, this package claims the existing quota-notice slot and shows a localized balance warning with a Top up action leading to the same recharge panel. Changing or signing out of the observed account dismisses the notice. The separate DeepSeek `ACCOUNT_QUOTA` notice retains its original owner; channel and provider quota errors cannot open this product recharge warning.

Product balance notices from media tools and background jobs require an exact match with the current signed-in `accountOwner`. Missing or stale login scopes cannot open the recharge dialog; recorded failure reasons remain visible. The dialog rechecks scope on render as well as account changes.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [client entry](src/client/index.ts) connects the account panels and workspace guide to the shared layout and slots. The [workspace guide store](src/client/workspace-guide-store.ts) owns the single open dialog and captured draft selection; the [Credits host](../../host/credits-index/README.md) owns account authorization and usage reads.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Credits host](../../host/credits-index/README.md): account and usage authorization.
- [Web Client](../../../docs/subsystems/web-client.md): client composition.
- [Conversation](../../../docs/subsystems/conversation.md): ordinary draft submission.

<a id="model-experience"></a>
## Model Experience

### Account panels and workspace examples

#### What the model sees

This package adds no tools or model calls. Reads from `/credits/api/usage` do not enter model input. Workspace examples remain unsent draft text until the user sends them through the ordinary conversation input. Saved media preference metadata accompanies ordinary prompt admission; the Credits host owns durable selection snapshots and their generation-tool use.

#### Token effect

Account analytics and opening or inserting an example consume no model tokens. Ordinary conversation submission owns any subsequent token use.

#### KV Cache effect

Account analytics and unsent examples do not change the model's KV cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Usage follows the current account's consumption billing records; recent charges may appear later. Consumption record counts are not API request counts, and separately recorded refunds are not deducted here. Input/output token breakdown and per-request ledger details are unavailable in this view. Some image and video tasks report no tokens. The host reads billing records with the current account's authorization.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
