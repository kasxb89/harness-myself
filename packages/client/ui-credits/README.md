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

The balance panel displays the current account's credits, phone sign-in, and usage analytics. The separate top-up panel owns payment. Both panels share the existing session and balance store; usage queries use the signed-in account selected by the Credits host (`host/credits-index`).

The injected `creditsSession` source exposes that same account snapshot to sibling client plugins. Subscriptions retain the shared account refresh; the last release stops its timer and focus listener. Logout clears the observed account before waiting for revocation, and older account or balance reads cannot restore the signed-out identity or replace another account's balance.

The desktop welcome opens `?panel=credits` to select the balance panel and phone sign-in form. The client consumes this entry request once, removing only `panel` while preserving other query parameters and the hash. Opening the page does not create an account session or configure an API key. Successful SMS verification refreshes the account session and returns to the existing conversation workspace without creating or clearing its Session, even when no registration reward is returned. Later balance and top-up selections, account refreshes and balance refreshes preserve the chosen panel.

### Top-ups

Top-ups accept positive whole-yuan amounts and display the host's converted points, never upstream quota. Creating an order displays its WeChat QR and polls that order until a terminal response. A failed read preserves the QR and balance, explains that payment is unconfirmed, and offers another status read without creating a second order. Stopping checks aborts the active HTTP read without cancelling the payment. An unrecognized payment status stops automatic reads, remains visibly unconfirmed, and keeps the same order available for another status check. Replacing the order, changing accounts, or closing the panel discards late responses; confirmed payment refreshes the balance.

### Usage analytics

Today, seven-day and thirty-day periods use Asia/Shanghai calendar days through the query time. A model filter applies to the consumption, billing-record and token totals, daily trend, model ranking and equivalent detail tables. Refresh keeps the last successful values visible for the same period when a later read fails; changing the period clears the previous values while loading. Account changes unmount the previous account's analysis, and late responses cannot replace the current selection.

The charts represent reported cumulative charges before refunds, consumption billing records, and combined token usage. A successful complete response supplies zero-valued day buckets where no records exist. Empty responses show an empty state; unavailable, malformed or overflowing data produces a visible error without manufactured chart values. All labels, units and query-state messages follow the product locale and theme.

### Workspace guide

The signed-in conversation composer has a lightweight Workspace examples entry. It opens only at the user's request and explains natural-language video planning, generation within each model's clip limit, and trimming and joining generated or uploaded clips. This reference dialog is separate from the AI's request-specific clarification questions in chat. Escape, backdrop and close dismiss it. Only one examples dialog can be open across the client root's mounted conversations; changing accounts or releasing the composer closes it. Its state stays in memory, with no account acknowledgement or first-visit behavior.

Choosing an example inserts plain text at the captured selection's end, preserves existing text, reference chips and attachments, and never submits or starts a billable operation. A newer draft revision or busy composer refuses insertion and shows a notice; reopening the examples captures a fresh insertion position.

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

This package adds no tools or model calls. Reads from `/credits/api/usage` do not enter model input. Workspace examples remain unsent draft text until the user sends them through the ordinary conversation input.

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
