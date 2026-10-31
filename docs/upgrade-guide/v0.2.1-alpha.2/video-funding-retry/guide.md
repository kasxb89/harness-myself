---
kind: upgrade-guide
description: "Retained video works record proven unsubmitted funding failures and explicit retry attempts."
---

# Continue a video work after adding funds

English | [中文](guide.zh.md)

## Change

Previously, a retained video work could become permanently failed after an unsubmitted balance rejection. The client now retains funding-rejection proof and attempt history in its private video project and creation records. A later real user message or question-card answer can authorize a new attempt within the original work. Existing accepted tasks and saved clips retain their original identities.

Old records remain readable. Missing proof does not establish that a task was unsubmitted. Recovery reads an original task when available; unconfirmed or already accepted submissions cannot be repeated through this funding-retry path. Older clients cannot offer the new recovery behavior.

## Migration

1. Keep existing private project records, creation records, and saved media. Do not clear them to remove a failed state.
2. After adding funds, explicitly ask the original chat to continue the original work. The client rechecks original-task proof and current submission approval before creating a distinct attempt. Payment confirmation alone does not restart generation.
3. Confirm that the original project is retained and saved clips are reused. If the original submission remains unknown, keep its task identifier for verification instead of submitting it again.
