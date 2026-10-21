# Agent Note: Retain image receipts through interrupted waiting

Status: implemented

English | [中文](2026-10-21-image-task-receipt-recovery.zh.md)

## Problem

A local image timeout or cancellation cannot establish whether the provider accepted, completed or charged a request. Losing an accepted task id prevents safe recovery, while treating stopped waiting as a cancelled remote task permits duplicate paid submissions.

## Decision

The Credits Host owns one paid submission and its receipt. It retains the configured backend fingerprint, relative route, model and available request/task ids before dependent work. Final settlement atomically retains the latest receipt as a fallback for an interrupted earlier write. Account, conversation, workspace and exact invocation authorize recovery; every query and output save rechecks the initiating account. Recovery performs task GETs and downloads without another generation POST.

Submission, query and overall task deadlines are separate configuration. A pre-submit failure is safe to stop. A submitted request without a confirmed outcome remains unknown; an accepted task whose query or download stopped remains pending. Only an explicit rejection or terminal provider failure establishes failure. Local cancellation cannot establish remote cancellation. Retained uncertain panel tasks block another panel plan in the same conversation, including after a reload.

The private creation JSON keeps its existing version and accepts optional receipt fields. Old records without receipts remain readable and retain their unknown-submission protection. Session event formats are unchanged. Query recovery reuses byte-identical outputs belonging to the original operation; missing old files can be downloaded again without overwriting them.

## Alternatives considered

Extending only the submission timeout leaves restart, cancellation and query failures unrecoverable. Reposting after a timeout risks duplicate work and billing. Matching tasks from nearby timestamps cannot establish an exact receipt or safe retry. Automatically releasing legacy unknown records discards the protection precisely where receipt evidence is missing.

## Consequences

Transient GET failures have bounded retries and a complete task deadline. Continuing later requires querying the retained task. Records with no task id require reconciliation of the original request and billing; the client cannot manufacture a recoverable task id or promise that the provider stopped. Persisted credentials, raw provider payloads and arbitrary query URLs are excluded from receipts.
