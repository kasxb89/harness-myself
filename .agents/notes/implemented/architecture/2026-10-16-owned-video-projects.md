# Agent Note: Retain paid video submissions as owned projects

Status: implemented

English | [中文](2026-10-16-owned-video-projects.zh.md)

## Problem

A conversational request can exceed a video model's clip limit. Joining several paid generations introduces partial results, unknown submission outcomes, and local editing failures. A process restart loses live background jobs but must not imply that accepted upstream work was cancelled or never charged.

## Decision

The credits host plans against the current account's actual model durations and saves the exact ordered requests before dispatch. A private project binds them to the account, calling chat, and workspace. Each submission is recorded before sending and each returned task identifier before polling. Explicit recovery queries known tasks and reuses saved clips; a submission without a persisted identifier remains an unknown charge and is never automatically repeated. The [package reference](../../../../packages/host/credits-index/README.md#video-projects) owns limits and operational semantics.

The existing jobs service owns live execution. Separate project records own recovery, without changing the agent loop or Session format. Bundled media executables run through session filesystem and process policy; a real encode in the selected output tree succeeds before paid dispatch. Only independently inspected output becomes a final artifact.

The same ownership rule protects structured image and video creation plans. Explicit plan and shot identifiers join character and material descriptions to actual operations; the [creation sidebar](../../../../packages/client/ui-creative/README.md) reads those retained records and video manifests. Saved files and extracted frames are exposed through checked media identifiers, while dialogue and subtitle instructions remain unverified requirements. Refreshing a display never resumes or repeats a paid task.

## Alternatives considered

**Ask the model to issue independent clip calls and shell commands.** That leaves partial billing and recovery implicit and depends on ambient tools being installed.

**Retry every interrupted submission.** An interrupted response can follow an accepted, billable task. Repeating it risks duplicate charges.

**Treat a retained record as a running job.** A saved manifest cannot establish that an executor survived a restart or that its output exists.

## Consequences

Users can request a complete duration and continue editing retained clips. Generation continuity still depends on the selected provider, and upstream tasks may continue billing after local cancellation. Private records and source media consume storage until explicitly removed. Keyless tests exercise account binding, unknown outcomes, recovery, actual sandboxed composition, and verified final duration; they do not establish provider rendering quality.
