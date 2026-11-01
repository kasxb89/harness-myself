---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-chat-media-preferences

English | [中文](2026-11-01-chat-media-preferences.zh.md)

## Summary

Adds the required media/request-selection event to capture personal media defaults once for each admitted human RPC, independently of later preference changes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-chat-media-preferences
baseline: false
changes:
  - root: "event:media/request-selection"
    previous: null
    after: "398f876feef88e9156a9fb896dacf0c9fa6e6ed6fefa43ad532377b10440dd96"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session events and format-4 files remain unchanged and readable. Absence of the new event retains legacy media resolution. A new event contains only the request identifier, static model/parameter choices and opaque preference scope/revision, or a bounded unavailable marker; it is not model-generated authorization and does not replace accepted task recovery or non-H3 price confirmation. The discriminator is required, without ignorable:true. The production format-4 vocabulary restorer accepts it with the current known-event set and rejects the same fixture with the previous reader's known-event set, preventing silent removal of choices that affect generation and billing. The existing format version is retained because the event discriminator gives safe refusal in the older-reader direction; no committed generation or historical record is rewritten.

<a id="verification"></a>
## Verification

The three focused Host suites media-preferences.spec.ts, media-request-selection.spec.ts and media-preferences-routes.spec.ts passed 23 tests, including a real Loader and authenticated HTTP routes, pricing-before-model directory initialization, scope/CAS isolation, required per-RPC snapshots, opaque native/PTC attribution, explicit human overrides, legal batches and auxiliary images. The independent production vocabulary-restorer check accepted the new fixture with current vocabulary and refused the previous vocabulary. Existing accepted/unknown-task, recharge-retry and non-H3 quotation checks were exercised separately. All providers were local fixtures; no paid generation or server deployment occurred. The upgrade guide explains retaining an updated reader for affected chats.

<a id="dev-note"></a>
## Dev Note

None.
