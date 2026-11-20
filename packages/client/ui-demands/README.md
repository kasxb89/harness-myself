---
description: "Publish requests, discuss public forum posts, and use official services with private media conversations."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-demands

English | [中文](README.zh.md)

## Summary

The Publish request sidebar opens Request square, Forum, Case showcase and Official services tabs. Request square opens approved public requests; My requests retains the signed-in user's drafts, published requests, accepted requests and private history. Forum supports public posts, replies, Unicode emoji and likes, with image attachments, personal activity, notifications and nicknames when the backend advertises them. Case showcase displays explicitly configured images and videos, with category filters and source attribution. Official services displays the platform's service catalog and retains its private human-engineer conversations. The backend owns publication, approval, acceptance, assignments, permissions and processing status.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Compose this browser plugin with slots, locale, layout and the existing Credits account source. The shipped Web bundle includes it. The local `enabled` carrier setting defaults to true and keeps the sidebar entry visible while signed out, loading, unavailable or reading a disabled service. Setting it to false disables local transport and hides that entry. Backend `config.enabled` determines whether customers can start new demands. An older backend without the demand API is unavailable. A disabled service retains already loaded history and obtains current permissions from the server; it does not invent engineers or discard old demands. Request square, Forum, Case showcase and Official services remain separate tabs; account-protected lists, conversations, uploads and mutations still require sign-in.

The Host publishes the declared public carrier settings and case catalogue in a structured page-bootstrap row. Browser module activation does not forward Host Loader configuration. The browser validates the public row before creating controllers; explicit Client options override those page defaults. Reloading the page reads updated settings. Account credentials and unrelated Host fields are not part of this payload.

`requestTimeoutMs` bounds each metadata request; `uploadTimeoutMs` independently allows slower binary upload slices. `foregroundPollMs`, `backgroundPollMs` and `listPollMs` control refresh cadence. Backend upload rules supply accepted MIME types, file counts, per-media size limits and resumable slice size. Customers must sign in through the existing account page; this plugin does not create a second login.

## Understand the implementation

The account-owned controller publishes a stable JSON view to framework-bound injection hooks. Components own viewing controls and narrow-screen navigation. Changing the account or login epoch immediately clears the prior view and cancels its requests and uploads. Responses must match the captured account. Disposal cancels and joins all owned asynchronous operations.

Community orders use an independent controller, journal and authenticated `/credits/api/community-demands` proxy. Public discovery and new publication or acceptance require the backend's explicit approval capability and policy. An older backend retains My requests and authorized participant conversations. Publication requires explicit public consent and shows the title, summary, budget, optional expected delivery date and public attachments before submission. Existing private requests, messages and attachments are never published automatically. Public discovery accepts only approved listing fields. A single server-confirmed acceptor joins the publisher's private conversation as an ordinary user; administrators can inspect community orders, participant messages and media. Disabling new requests retains authorized conversations and original pending-operation recovery.

Forum posts, replies and liked-state updates use an independent, account-scoped controller and journal behind `/credits/api/forum`. Image uploads use the advertised MIME, size and count limits, bounded chunks and their original upload identities. Only server-confirmed ready images can be bound to a post or comment; image-only content is valid with those attachments. Submissions freeze the original UUID, body, ordered attachment identifiers and optional same-post reply target. Recovery first queries the original receipt when supported; an older backend retains explicit replay of the original frozen text request. An uncertain like first reads its current state. No unknown operation is automatically replaced or resubmitted. Network failures retain verified content; explicit forbidden or not-found detail responses revoke its cached body and media.

Request square uses responsive cover cards with the public title, short description, original budget, supplied delivery date and publisher. Authorized listing images and videos provide covers; absent or failed media leaves a text card. Opening a card uses its original identifier. My requests shows actual review status and owner-visible rejection reasons, keeping legacy and community records separate. Missing budgets and dates are not invented. The publication form places an explicit media picker and drop target beside its public description; accepted types come from the backend. Ready uploads preview only through the owning account's authorized content URL, while pending uploads retain progress and recovery controls. Forum uses full-width horizontal rows and a dismissible drawer entering from the right, keeping the list visible on desktop. The article sits beside an independently scrolling comment list and fixed reply form, stacked when the drawer is narrow. Closing the drawer restores focus and retains unsent reply text. Post and reply composers offer a keyboard-accessible Unicode emoji chooser that inserts at the current selection without submitting.

My posts and My comments use server-scoped cursor pages. Reply and like notifications use actual recipient-scoped counts; the sidebar shows a verified unread indicator, and opening a notification locates its post or comment and explicitly acknowledges the original notification identifiers. Concurrent read acknowledgements cannot restore an older count. Forum nicknames use their own revision-checked backend profile; a lost save response is checked with GET before any further write. Account phone numbers and login names are never author-name fallbacks. Missing capabilities retain the older text-only flow without showing unconnected controls.

`showcaseItems` supplies public case metadata independently of demand publication. Each record has a category, cover and explicitly selected image or video URLs, plus optional source and attribution. The tab does not scan local files or generate customer records; an empty catalog stays empty. Relative media paths use the application mount prefix. HTTPS sources and loopback development URLs are permitted; presentation rejects executable URLs and embedded credentials. Material files remain with the deployment static asset owner.

Legacy private cards retain their original conversation and draft actions. Checking an unconfirmed publication does not create a new request. The conversation uses a compact inbox, message history and composer. Enter sends a ready message; Shift+Enter inserts a newline, and composition confirmation does not send. Optional request details and upload rules remain expandable. Switching conversations preserves independent drafts for the controller's lifetime; only journaled pending operations and uploads survive an application restart.

The compact inbox identifies service conversations by their service name and retains the original title in the preview. Search includes service names, original titles, request numbers and the latest server-confirmed message preview; a draft's body is searchable only while that draft is selected. Separate requests retain their own identifiers even when they use the same service. Draft and server-owned processing states remain explicit, and available service artwork does not imply that an engineer is online.

When the backend declares service-profile support, the directory uses bounded server pages, search and category filters. Changing filters cancels the previous directory read; a late page cannot replace the newer result. Service profiles describe request types, not individual online staff. New requests first enter the platform's unassigned queue; the original service name remains visible after assignment. An older backend retains the direct engineer directory and submission path. Customer profiles remain in backend administration and are never part of this public directory.

Requests use the authenticated local `/credits/api/demands` proxy, whose credential and renewal ownership remains in [credits-index](../../host/credits-index/README.md). Tokens stay in the Host. Media elements use local attachment identifiers and owner guards; the Host authorizes fresh content access and forwards Range responses for video seeking.

Each new demand, message, upload and acceptance has a durable, account-scoped operation identifier and frozen request body before dispatch. A lost response retains that operation for exact retry instead of creating a replacement identifier. Separate drafts remain independent. Confirmed messages and read status come from server receipts. Images and videos upload as bounded `File.slice` chunks, with offset reads after an uncertain chunk. Reselecting a file verifies its metadata and recorded slice digests before continuing. Files themselves are not copied into the JSON view or local operation journal.

Direct-engineer operations retain their existing journal namespace and serialized bodies. Service-profile operations use a separate namespace that the new reader combines with the legacy journal. Returning to an older client therefore does not expose service-only records to its legacy parser.

Community publication, acceptance and messages keep separate durable operation identifiers. Unknown outcomes expose a check of the original operation, and known failures retain their actual error category. A blocked operation does not block another order. Public and conversation uploads keep immutable visibility scopes, verify a bounded incremental whole-file SHA-256, and resume from verified server offsets. Community messages retain server sequence numbers; local unconfirmed messages remain separate records. Read acknowledgements require the selected, visible conversation and confirmed message sequences.

## Further Exploration

- [Credits host](../../host/credits-index/README.md) — account-bound demand proxy and media access.
- [Web client architecture](../../../docs/subsystems/web-client.md) — observable data and presentation ownership.
- [Sidebar](../ui-sidebar/README.md) — navigation contributions.

## Model Experience

### Human-engineer requests

#### What the model sees

The `demands` panel adds no prompts, tools, model messages or AI Sessions. Demand conversations and forum discussions use their separate backend services.

#### Token effect

Human messages, forum discussions and attachment operations do not submit model requests or enter the AI generation billing path.

#### KV Cache effect

Demand and forum navigation and content do not alter model context or provider caches.

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
