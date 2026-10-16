---
description: "Write and revise creation prompts using the current account, draft, materials and generation settings."
kind: "package-reference"
---

# AI prompt writing

English | [中文](README.zh.md)

## Summary

Reference for `@deepseek-ai/dsh-client-ui-prompt-assist`, the shared writing and revision actions beside the image and video workspaces' main prompt. The root-scoped `creation.prompt.assist` factory keeps feedback and operation state separate for each render occurrence. The [Slots reference](../../../docs/subsystems/slots.md) defines factory composition.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The owner supplies the creation kind, current main prompt, all relevant image material identifiers, generation parameters, account identity and availability. “AI writing” immediately reads that context and requests a replacement prompt; successful completion writes directly into the main input. The user can edit that input freely. “Revise with feedback” uses its current text and the feedback field, then replaces the same input. Materials are uploaded, previewed and removed by the workspace's single material entry.

`onPromptChange(next, expectedPrompt)` lets the owner atomically compare its live draft and creation context before replacing text. Returning false keeps the current draft and feedback and reports that no replacement occurred. `onBusyChange` reports only an active operation's acquisition and release. The owner uses it to block material uploads and media generation while keeping the main prompt editable; it must not feed that same busy flag back into the factory's `disabled` prop, which describes external upload or media-generation activity.

One AbortController owns account verification, model submission and final account verification. The Host independently verifies the expected account before dispatch. The factory replaces text only if both account checks succeed, the owner context still matches and the final owner callback accepts the replacement. Editing the main prompt, changing materials, parameters or account, cancellation, and unmounting abort waiting and discard late results. Only the currently owned operation releases its busy flag. Errors and rejected replacements preserve the main draft and feedback; a successful revision clears the feedback field.

Requests post to `/credits/api/prompt/assist` with the current main prompt, deduplicated image identifiers, generation parameters and expected account identifier. Initial writing sends an empty instruction; revision sends the feedback. The browser neither receives nor submits an API key. Writing and revision never start image or video generation.

<a id="model-experience"></a>
## Model Experience

### Prompt writing and revision

#### What the model sees

On an explicit writing action through `/credits/api/prompt/assist`, the Host receives the current main prompt, workspace image identifiers and generation parameters. A revision adds the user's feedback. The Host owns image validation, model selection and account authorization. Rendering the actions, typing feedback and editing the main prompt make no model request.

#### Token effect

The prompt accepts up to 7,000 characters and revision feedback accepts up to 2,000. AI writing reads at most six image materials, up to 6 MiB each and 12 MiB combined; the Host validates their complete byte sizes before dispatch. Each writing or revision action can consume the current account's AI credits.

#### KV Cache effect

Each writing action is an independent Host request. The client keeps no model conversation and owns no provider cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Revision feedback is local to the mounted factory occurrence and is not persisted across reloads or panel unmounts.
- Stopping after model dispatch cannot guarantee that the request has not already been processed or charged; stopping the initial account check makes no model request.
- Model availability and image-reading capability depend on the Host's configured prompt-assistance models.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
