# Creation publications

English | [中文](README.zh.md)

## Summary

Reference for `@deepseek-ai/dsh-client-creation-content`, the shared publication reader used by image and video creation. The local administration service owns page copy, categories, templates, preview assets and prompt presets; this plugin provides one React-free `ctx.creationContent` observable to both workspaces.

## Publication reads

The reader fetches `/credits/api/creation/content` through the origin-checked Host relay. Only published templates and presets are exposed; disabled categories and their templates are excluded. Uploaded preview media uses `/credits/api/creation/assets/:id`; it is separate from account-owned reference materials. An empty publication remains empty rather than inventing sample content.

`getSnapshot()` preserves identity until state changes. `subscribe()` returns a disposer, and `refresh()` coalesces simultaneous readers. The `loading`, `ready` and `error` states distinguish the initial read, usable publication and failure. A failed read retains the last validated document, so consumers can disclose stale content and offer retry. A successful read of a new revision replaces the complete document. Consumers inject the observable through the renderer's `hooks` compartment; components never subscribe directly.

The validated `refreshIntervalMs` setting defaults to 15,000 milliseconds (1,000–300,000); `timeoutMs` defaults to 10,000 milliseconds (1,000–60,000). Visible clients refresh periodically and on focus or visibility restoration. Plugin disposal removes listeners and timers, aborts the request, closes subscriptions and awaits completion. No user credentials enter the publication request.

## Model Experience

This plugin sends no model requests and owns no token budget or KV cache. Selecting an administrator-authored template or preset changes the user's editable creation brief; the creation workspace owns any subsequent explicit model submission.

## Known Limitations and Deferred Work

- Publication updates require the local administration service to be available; changes can take one refresh interval to appear in a focused client.
- Assets remain immutable after manifest entries are removed. Storage garbage collection is owned by the administration service.
- The document supports Chinese and optional English copy; consumers fall back to Chinese when English is absent.
