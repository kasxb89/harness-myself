---
kind: upgrade-guide
description: "Prompt admission reports a confirmed unknown model with session/model-unavailable instead of session/agent-busy."
---

# Unknown-model prompts require explicit model selection

English | [中文](guide.zh.md)

## Change

When the exact model resolver rejects a saved selection with `UNKNOWN_MODEL`, `session.prompt` now returns `session/model-unavailable` with optional `details.reason: UNKNOWN_MODEL` before attachment admission or prompt queuing. Previously this failure returned `session/agent-busy`. Other resolution failures keep their existing classification. Models accepted by the resolver remain usable even when absent from the picker catalog.

The composer asks the user to select a model and retains the draft and attachments. Model selection does not automatically resend the prompt.

## Migration

1. In custom JSON-RPC clients, handle `session/model-unavailable` with `details.reason === 'UNKNOWN_MODEL'` by offering manual model selection. Keep the draft and attachments until the user explicitly sends again.
2. Confirm the rejected prompt queues no message and switching models sends no request by itself. No settings or Session-data migration is required.
