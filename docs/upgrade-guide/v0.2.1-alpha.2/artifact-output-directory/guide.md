---
kind: upgrade-guide
description: "New product video projects publish to the managed artifact directory rather than leaving the only final output in the conversation workspace."
---

# Managed product artifact destinations

English | [中文](guide.zh.md)

## Change

The product composition now provides managed artifact storage. New images and single videos retain the default `<Harness home>/plugin-data/credits/media` location unless the user changes it in Artifacts. New video projects and local video edits also publish their completed files there, after sandboxed editing in the workspace. Tools return the published path. Existing project records without a captured publication directory keep their original workspace destination when resumed. Existing files and chat links are not migrated or rewritten.

## Migration

1. In Artifacts, check the current save directory. To use another location, select an existing writable directory and save it. Changing it affects future operations; in-flight operations keep their captured destination.
2. Custom compositions can set `defaultOutputDirectory` and `stateDirectory` on `@deepseek-ai/dsh-artifacts-index` and provide authenticated `connection`. Keep private state separate from every output root. Omitting managed storage retains the credits host's prior output behavior.
3. Generate or save a file and confirm its returned path lies in the selected directory and appears in Artifacts. Earlier configured and selected roots remain visible. Renaming or recycling changes a file's path; restore from the recovery area to recover its original location.
