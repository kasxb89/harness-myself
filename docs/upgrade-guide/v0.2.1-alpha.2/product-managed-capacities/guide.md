---
kind: upgrade-guide
description: Product model capacities now follow the authenticated backend instead of smaller model-level manual overrides.
---

# Product-managed model capacities

English | [中文](guide.zh.md)

## Change

The product account model synchronizer marks verified `context_window` and `max_output_tokens` capacities with local `managedLimits.authoritative: true`. These capacities take precedence over saved model-level `contextWindow` and `maxTokens`, including smaller values saved by older clients. Changes apply to subsequent requests in existing conversations after the model catalog refreshes. Explicit smaller request budgets and SDK context headroom continue to limit each request.

The marker requires the same backend and account scope. Missing or invalid fields retain that owner's last verified capacities. A capacity the backend has never declared retains its existing fallback. Provider routes outside the product account synchronizer keep their existing manual-capacity behavior.

## Migration

1. Configure each product model's context window and maximum output in the backend model settings using verified channel limits.
2. Upgrade the client, then open its model selector or allow the existing 60-second catalog refresh to finish. Local model-capacity edits are unnecessary.
3. Send another message in the existing conversation. Check its request options and actual channel request to confirm the refreshed output budget, subject to any smaller explicit request budget and remaining context.

Stored manual capacities remain in the profile. To impose a smaller budget for a particular request, use that request's `maxTokens` control.
