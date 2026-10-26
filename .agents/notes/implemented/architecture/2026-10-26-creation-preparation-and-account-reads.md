# Agent Note: Creation preparation and account reads

Status: implemented

English | [中文](2026-10-26-creation-preparation-and-account-reads.zh.md)

## Problem

Refreshing a chat's displayed charges re-read historical receipts after a short view-cache expiry. In-flight concurrency did not constrain request frequency, and a shared gateway limit could also reject balance reads. Treating a null failure payload as success erased the explanation. Creation workflows separately repeated dependency preparation and generated common Office programming steps during each conversation.

## Decision

Receipt identity and freshness belong to a login-owned ledger, independently of display freshness. A paced account reader shares exact requests, retains observed HTTP and retry facts, and delegates credential renewal to the existing sole owner. Capability-discovered read-only batches reduce initial history fan-out; failure never expands a batch into individual reads. Consumption logs remain distinct from final net settlement.

Image submission identity comes from the captured account, workspace, human source and logged call coordinates. An exclusive durable claim precedes any upload or paid request. A retained unknown claim prevents replay of that submission without prohibiting another source. Background jobs own local cancellation and visible phases; retained creation receipts own provider recovery. A local job finishing its observation does not establish provider success or cancellation.

Dependency reuse follows the verified payload identity rather than the application's display version. Separate installation generations preserve paths still used by other processes. Common Office tools own deterministic authoring and necessary checks while existing programmable workflows retain complex designs and edits. Cache reuse requires the relevant content and environment identities; uncertain identity causes fresh work rather than invented validity.

## Alternatives considered

**Increase the gateway's global limit.** This leaves repeated historical reads and shared-network interference unexplained. Client coalescing and pacing remain necessary even when the server isolates authenticated read budgets.

**Use prompt similarity as submission identity.** Users can intentionally request the same content again. Logged source and call coordinates distinguish that request from replay of one submission.

**Return a background id and call the operation successful.** Responsiveness does not shorten generation or settle billing. Results retain the original unknown or pending provider outcome.

**Skip document checks to reduce latency.** Common structured execution removes improvised programming and repeated setup while preserving format, formula and layout verification obligations.

## Consequences

Older APIs retain a paced single-receipt path. A new batch is used only after precise capability discovery. Receipt caching has a separate configurable lifetime so later adjustments can be read. Background jobs are process-local; their durable plan and operation coordinates remain the recovery entry after restart. Runtime generations consume additional disk until they can be retired without deleting another process's executable files.

## Verification

Loader and local HTTP tests cover empty-body 429, Retry-After, a single 401 renewal, login transitions, batch bounds and no failure fan-out. Real job-registry tests cover fast completion, original-task recovery, cancellation and quiescent teardown. Office fixtures exercise native editable objects and formula recalculation; dependency fixtures cover concurrent processes and damaged installations.
