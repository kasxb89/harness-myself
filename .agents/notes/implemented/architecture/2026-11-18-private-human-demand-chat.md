# Agent Note: Private conversations with human engineers

Status: implemented

English | [中文](2026-11-18-private-human-demand-chat.zh.md)

## Problem

Customers need to publish work and exchange images and videos with real engineers. AI Sessions have model-visible logs, generation tools and billing semantics; their upload interface requires a Session identity. Reusing that domain would obscure who receives a human message and could attach private customer files to an unrelated AI conversation.

## Decision

The demand service owns separate requests, messages, assignments, read cursors and private attachments. The browser's [demand plugin](../../../../packages/client/ui-demands/README.md) presents backend-managed service profiles, actual assigned engineers and server-confirmed statuses. It contributes no model inputs or generation operations. The existing [Credits Host](../../../../packages/host/credits-index/README.md) keeps account credentials and serialized renewal ownership; a narrow route family captures the observed login and validates it before dispatch and before returning data. A replacement account never inherits an old draft, response or transfer.

Service catalog entries describe the platform's intake directions and do not create staff accounts or online presence. A selected entry sends a demand to the unassigned queue before an administrator chooses a real engineer. The initial service name stays with that demand. Customer profiles remain administrative records until linked to an existing user; they do not grant login, credit or message access. Direct-engineer submissions remain available to older clients and backends.

Each mutation records a stable operation identifier and immutable request body before submission. A lost receipt retains that exact operation for recovery, while independent drafts remain available. Uploads use bounded file slices, explicit server offsets and persisted slice digests; media access obtains a fresh authorization for the exact attachment and supports Range without exposing an upstream capability to the renderer. The backend controls whether new requests are accepted and retains authorization over existing history when publication changes.

Service-target operations occupy a separate journal namespace so an older client does not reject their unsupported fields together with its original direct-engineer operations. The new reader combines both namespaces without rewriting legacy bodies or keys.

## Verification

Controller tests cover identity replacement, durable unknown submissions, multiple recoverable drafts, read cursors, upload offsets and acceptance reconciliation. Host tests cover route and JSON allowlists, owner checks, cancellation, authorized content URLs and Range responses. Assembled browser scenarios exercise the catalog, private chat and media controls; an opt-in synthetic loopback Go fixture checks the actual backend, Host and browser together without customer credentials or production data.

## Alternatives considered

**Reuse AI chat Sessions and their attachment store.** Rejected because human conversations need independent recipients, authorization and processing status, and must not become model context or generation accounting.

**Give the browser the product access token.** Rejected because the existing Host already owns token renewal, logout and cross-account checks; duplicating that owner increases credential exposure and races.

**Retry a lost submission with a new identifier.** Rejected because transport failure does not establish that the server rejected the original operation. Exact operation replay and offset reads recover the prior result without duplicating it.

## Consequences

- The local operation journal must be available before a mutation; storage failure stops that operation without blocking independent product features.
- Application restart requires reselecting an interrupted upload's original file; its metadata and recorded slice digests must match.
- Engineer staffing, assignments, private storage and administration depend on the separate backend domain, while the established product login remains unchanged.
