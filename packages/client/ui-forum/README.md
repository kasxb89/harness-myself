---
description: "Community posts, likes and immediate comments in the request workspace."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-forum

English | [中文](README.zh.md)

## Summary

Adds a Forum tab beside the service directory and private requests. Posts and comments appear immediately. Administrators review or remove content afterward in harnes-api. This package shares the product login and keeps forum content separate from private demand messages and model generation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The Web bundle mounts the Forum tab through `demands.forum`. The existing credits Host privately forwards only `/api/product/forum` operations. Browser code receives public author names and account guards, never upstream credentials or private customer profiles. The backend administrator enables new forum writes; disabling writes preserves existing discussions.

`requestTimeoutMs` sets the complete request deadline, defaulting to 20 seconds. `refreshMs` refreshes a visible forum, defaulting to 15 seconds. Chinese and English dictionaries own all interface copy.

## Understand the implementation

Publications retain an account-scoped request ID and immutable body before dispatch. An unknown result keeps that draft for a manual retry of the same submission. Confirmed comments render from their original receipt before follow-up reads. Desired-state likes are unique per user and post. Moderator removal revokes server reads and disappears on the next successful client refresh. Forum requests do not reuse private demand or AI Session attachments.

## Further Exploration

- [Credits Host](../../host/credits-index/README.md) owns product credentials and renewal.
- [Demand workspace](../ui-demands/README.md) owns the forum's tab position.

## Model Experience

### Community discussions

#### What the model sees

The `demands.forum` slot adds no prompts, tools, AI Sessions, or model requests.

#### Token effect

Forum messages do not enter generation billing or the model context.

#### KV Cache effect

Forum actions do not change provider caches.

## Known Limitations and Deferred Work

- Posts and comments support text. File uploads, nested replies, and live push notifications are not implemented; visible discussions refresh at the configured interval.

### Dev Note

The forum has its own plugin and API domain so moderation cannot expose or remove private demand conversations.
