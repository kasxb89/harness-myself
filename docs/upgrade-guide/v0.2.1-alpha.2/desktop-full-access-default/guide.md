---
kind: upgrade-guide
description: "New Desktop conversations default to Full access instead of workspace permissions."
---

# Desktop conversations default to Full access

English | [中文](guide.zh.md)

## Change

New Desktop conversations use `danger-full-access` with approval `never` instead of `workspace-write` with approval `ask`. This removes the Harness file sandbox's workspace restriction for those conversations; operating-system permissions still apply. Existing conversations keep their permissions. Saved user defaults and explicit `DSH_PERMISSION_MODE` or profile configuration continue to override the product default. The Web, headless, and SDK defaults do not change.

## Migration

1. To retain workspace permissions for future conversations, choose **Workspace Write** under **Settings → General → Permission**. Deployment operators can instead set `DSH_PERMISSION_MODE=workspace-write` before starting Desktop. No action is required to use the new Full access default when no explicit override exists.
2. Create a new conversation and check its Permissions selector. It should show **Full access**, or the lower mode you explicitly selected. Change an existing conversation through its own Permissions selector when desired; upgrading does not change it automatically.
