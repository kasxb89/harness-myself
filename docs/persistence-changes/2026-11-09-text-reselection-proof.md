---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-09-text-reselection-proof

English | [中文](2026-11-09-text-reselection-proof.zh.md)

## Summary

Adds optional LlmFailure.textReselection metadata to assistant attempt/message finish failures, provider retry records and turn-ending errors. The Session writer remains V4.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-text-reselection-proof
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "84cc09319a505381b842d2bb8d03e12330b7cb4a1259ab099ba209f806812b3a"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "161d69bce499c9478b51057eb3a15051b6ad3642c39b205f641e5c68156a4b0c"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "a83bfd204ab3bc6058ec57b16c3586a02affdf69749cdb523f1b3f97d19ef852"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "a19a35e70b1e457fd82d10f3d92639f8052007dcb5c7b23933c0d8a79f57341d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Old records omit the field and remain readable with their original failure meaning; absence does not establish that an upstream request or billing reservation was avoided. The pre-change Session reader identified in the local persistence compatibility report preserves the added subtree as ordinary JSON and continues to expose the existing error code and message. It can ignore this optional evidence and retain its existing unavailable-model behavior. Current readers preserve both record forms and the same model-visible messages. The addition changes no event discriminator, required field, header or lifecycle meaning. A restored proof is historical data, not a new request or an instruction to replay the failed operation.

<a id="verification"></a>
## Verification

Node 22.23.2: vitest run packages/session/session-format-catalog/tests/text-reselection.compat.spec.ts packages/core/session/tests/canonical-envelopes.spec.ts packages/session/session-format-catalog/tests/current.spec.ts passed all 216 tests. Independently executed the same synthetic legacy and zero-send fixtures with the exact pre-change reader checkout identified by the local compatibility report and current candidate: strict physical decode and artifact validation retained all 10 original events, four failure locations and the original message projection; detached Session restoration added only its existing ordinary resume marker and closed-tail repair returned no events. Stream expansion retained the optional subtree and existing code/message. A throwing fetch spy recorded zero calls in both readers; no Agent was resumed. The fixture SHA-256 is 4957d7c50c2727b6e0e41c076a5f1e29ab70ff3399a19e58a9eda8092a706215. These checks establish reader compatibility, not live reselection or provider availability.

<a id="dev-note"></a>
## Dev Note

None.
