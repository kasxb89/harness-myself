# Balance and usage

English | [中文](README.zh.md)

The balance panel displays the current account's credits, phone sign-in, and usage analytics. The separate top-up panel owns payment. Both panels share the existing session and balance store; usage queries use the signed-in account selected by the Credits host (`host/credits-index`).

The desktop welcome opens `?panel=credits` to select the same balance panel and phone sign-in form. This navigation does not create an account session or configure an API key. Successful phone sign-in refreshes the account session even when the response has no registration reward.

## Usage analytics

Today, seven-day and thirty-day periods use Asia/Shanghai calendar days through the query time. A model filter applies to the consumption, billing-record and token totals, daily trend, model ranking and equivalent detail tables. Refresh keeps the last successful values visible for the same period when a later read fails; changing the period clears the previous values while loading. Account changes unmount the previous account's analysis, and late responses cannot replace the current selection.

The charts represent reported cumulative charges before refunds, billing records including task adjustments, and combined token usage. A successful complete response supplies zero-valued day buckets where no records exist. Empty responses show an empty state; unavailable, disabled, malformed or overflowing data produces a visible error without manufactured chart values. All labels, units and query-state messages follow the product locale and theme.

## Model Experience

This package adds no tools or model calls. The account analytics are read-only and do not change token use or the model's KV cache. Workspace examples remain unsent draft text until the user sends them through the ordinary conversation input.

## Workspace guide

The signed-in conversation composer has a lightweight Workspace examples entry. It opens only at the user's request and explains natural-language video planning, generation within each model's clip limit, and trimming and joining generated or uploaded clips. This reference dialog is separate from the AI's request-specific clarification questions in chat. Escape, backdrop and close dismiss it. Only one examples dialog can be open across the client root's mounted conversations; changing accounts or releasing the composer closes it. Its state stays in memory, with no account acknowledgement or first-visit behavior.

Choosing an example inserts plain text at the captured selection's end, preserves existing text, reference chips and attachments, and never submits or starts a billable operation. A newer draft revision or busy composer refuses insertion and shows a notice; reopening the examples captures a fresh insertion position.

## Known Limitations and Deferred Work

Upstream hourly aggregates usually lag by about five minutes. Billing records are not API request counts; positive task adjustments can add records, and refunds are not deducted from consumption. Input/output token breakdown and per-request ledger details are unavailable in this view. Some image and video tasks report no tokens. The host requires the upstream service's usage export to be enabled and an authorized read for the current account.
