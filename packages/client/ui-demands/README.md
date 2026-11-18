---
description: "Private customer conversations, media attachments and delivery acceptance with human engineers."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-demands

English | [中文](README.zh.md)

## Summary

The Requests sidebar opens the platform's service catalog and the signed-in customer's private demands. Customers describe work, attach images or videos, and submit it for assignment to a real engineer. They can continue previous requests and accept delivery. The backend owns the catalog, assignments, permissions and processing status.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Compose this browser plugin with slots, locale, layout and the existing Credits account source. The shipped Web bundle includes it. The local `enabled` carrier setting defaults to true; backend `config.enabled` determines whether customers can start new demands. An older backend without the demand API is unavailable. A disabled service retains already loaded history and obtains current permissions from the server; it does not invent engineers or discard old demands.

`requestTimeoutMs` bounds each metadata request; `uploadTimeoutMs` independently allows slower binary upload slices. `foregroundPollMs`, `backgroundPollMs` and `listPollMs` control refresh cadence. Backend upload rules supply accepted MIME types, file counts, per-media size limits and resumable slice size. Customers must sign in through the existing account page; this plugin does not create a second login.

## Understand the implementation

The account-owned controller publishes a stable JSON view to framework-bound injection hooks. Components own viewing controls and narrow-screen navigation. Changing the account or login epoch immediately clears the prior view and cancels its requests and uploads. Responses must match the captured account. Disposal cancels and joins all owned asynchronous operations.

When the backend declares service-profile support, the directory uses bounded server pages, search and category filters. Changing filters cancels the previous directory read; a late page cannot replace the newer result. Service profiles describe request types, not individual online staff. New requests first enter the platform's unassigned queue; the original service name remains visible after assignment. An older backend retains the direct engineer directory and submission path. Customer profiles remain in backend administration and are never part of this public directory.

Requests use the authenticated local `/credits/api/demands` proxy, whose credential and renewal ownership remains in [credits-index](../../host/credits-index/README.md). Tokens stay in the Host. Media elements use local attachment identifiers and owner guards; the Host authorizes fresh content access and forwards Range responses for video seeking.

Each new demand, message, upload and acceptance has a durable, account-scoped operation identifier and frozen request body before dispatch. A lost response retains that operation for exact retry instead of creating a replacement identifier. Separate drafts remain independent. Confirmed messages and read status come from server receipts. Images and videos upload as bounded `File.slice` chunks, with offset reads after an uncertain chunk. Reselecting a file verifies its metadata and recorded slice digests before continuing. Files themselves are not copied into the JSON view or local operation journal.

Direct-engineer operations retain their existing journal namespace and serialized bodies. Service-profile operations use a separate namespace that the new reader combines with the legacy journal. Returning to an older client therefore does not expose service-only records to its legacy parser.

## Further Exploration

- [Credits host](../../host/credits-index/README.md) — account-bound demand proxy and media access.
- [Web client architecture](../../../docs/subsystems/web-client.md) — observable data and presentation ownership.
- [Sidebar](../ui-sidebar/README.md) — navigation contributions.

## Model Experience

### Human-engineer requests

#### What the model sees

The `demands` panel adds no prompts, tools, model messages or AI Sessions. Customer conversations belong to the separate demand service.

#### Token effect

Human messages and attachment operations do not submit model requests or enter the AI generation billing path.

#### KV Cache effect

Demand navigation and messages do not alter model context or provider caches.

## Known Limitations and Deferred Work

- Engineers, publication, assignments and private attachment storage require the corresponding backend domain.
- Interrupted uploads require the customer to reselect the original file after an application restart.
- The local operation journal requires available browser storage; unavailable or invalid storage blocks a new mutation before dispatch.
- Quotation, payment, contracts and refunds are outside this package.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
