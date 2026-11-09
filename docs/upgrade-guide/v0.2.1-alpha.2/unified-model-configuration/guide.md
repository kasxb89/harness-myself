---
kind: upgrade-guide
description: "New video project records use version 2 so older clients cannot discard their captured model configuration."
---

# Versioned model configuration and video projects

English | [中文](guide.zh.md)

## Change

New video projects use private manifest `version: 2`. Earlier clients accept only version 1 and refuse these new records before submitting generation. The current client reads both versions and preserves each record's original version when saving; existing version 1 projects are not migrated or assigned today's model configuration.

Published model versions bind each model's verified effective context/output limits, prices and image/video parameters. Configuration changes stop an unsubmitted operation rather than silently changing its model, price or specification. Accepted or uncertain task IDs remain available for original-task recovery. Context and output counts are independent model capabilities, not equal values or a fixed ratio.

## Migration

1. Keep the existing account session, private project records and saved media. Do not delete them or edit a manifest's `version`, model version or prepared requests.
2. Use the current client to resume a version 2 project. Downgrading to an earlier client cannot resume that project; original version 1 projects remain readable by the current client.
3. Refresh the model catalog after publishing backend configuration. Confirm the exact model's supported specifications and effective limits. If a configuration conflict stops a request, verify the original task history before explicitly starting another operation; refreshing or adding funds never automatically repeats the POST.

See the [account and creation package](../../../../packages/host/credits-index/README.md) for directory matching, version receipts and recovery behavior.
