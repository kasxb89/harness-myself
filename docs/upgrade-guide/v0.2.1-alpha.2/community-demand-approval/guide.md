---
kind: upgrade-guide
description: "Public community discovery, publication and acceptance require an approval-capable backend."
---

# Community request approval

English | [中文](guide.zh.md)

## Change

Request square requires `/api/product/community-demands/config` to declare `capabilities.community_approval_v1: true` and `publication_policy: approval_required`. An older backend cannot supply the public square or accept new public submissions from this client. Existing participant history and original pending-operation recovery remain available. Visible legacy listings are not treated as approved.

## Migration

1. Provide the compatible backend before distributing the client. Preserve the existing database, authentication keys, sessions and request receipts.
2. Review existing public requests in community demand management. Approve each request explicitly; changing visibility does not approve it.
3. Confirm that a new request appears under My requests while pending, then becomes publicly discoverable only after approval. Confirm that original conversations and pending-operation recovery still work without creating replacement requests.
