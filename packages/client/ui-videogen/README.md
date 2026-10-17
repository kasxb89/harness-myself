---
description: "Prepare video prompts and model-supported references, use published scripts or AI writing, and generate, play or download saved clips."
kind: "package-reference"
---

# Video creation

English | [中文](README.zh.md)

## Summary

Create video clips from an editable brief and the selected model's supported image, video or audio references. Published scripts and optional AI writing help prepare the brief before generation. Play and download saved clips while retaining drafts across mode switches. Generation uses the current account, and a failed connection can leave its outcome unknown.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Use the video mode of the shared desktop AI creation entry to prepare a clip and explicitly submit generation.

The composer offers text, image, first/last-frame and reference workflows only where the existing media catalog declares support. Hidden workflow media stays in the draft and is excluded from generation requests. First/last-frame mode requires both images. Changing models or workflows retains materials; generation sends only the inputs accepted by the active workflow and model. The injected creation-content catalog supplies published script cards, category labels, preset instructions, headings and prompt placeholders from the administration backend. Categories and scripts follow their configured order; draft scripts and disabled categories stay hidden. English content falls back to its Chinese text. Covers and optional demo videos use real creation assets, with no invented image or storyboard when absent. Loading, empty and failed catalogs show their actual state; failures offer retry without bundled business-content fallback. Script cards have category filters and a preview; applying a script appends editable text and does not submit a request. My clips lists real saved video artifacts, with playback and download.

The existing session, catalog, asset, generation and artifact routes remain unchanged. The unified material entry retains images for AI writing even when the selected video model cannot use them. First/last frames and reference images share the selected model's declared image/frame count, or the six-image writing limit for a text-only model, with 6 MiB per image and 12 MiB total. Reference videos accept at most 32 MiB each; models declaring audio references expose MP3/WAV uploads, native playback and removal, at most 15 MiB per audio file. Active generation references must total at most 48 MiB. Unsupported retained files stay removable without showing an upload input. Empty files are rejected. A failed batch retains files already uploaded, reports the failure and restores controls. The composer permits one upload or generation operation at a time. Generation requests execute once; a transport failure retains the draft and previous result and tells the user to inspect saved clips before submitting again. Preview URLs remain valid across mode changes and are released on removal, replacement or plugin disposal.

The prompt editor hosts the shared [AI prompt assistant](../ui-prompt-assist/README.md). It receives the current prompt, video settings and all deduplicated first/last-frame and reference images, including images retained from another workflow. Video and audio identifiers are never sent to writing. More than six retained images disables writing with a visible notice, preserving every reference for model-supported generation. Successful explicit writing updates the main prompt directly and focuses it; feedback rewrites that current text without starting video generation. While writing runs, upload, generation, workflow and settings controls are locked, and the main prompt remains editable. A final comparison of prompt, account epoch, materials, settings and media-operation state rejects late results after intervening changes.

The window draft retains the reference account and upload epoch across panel remounts. Parent images reach AI writing only after the live account matches the reference account. Switching accounts or signing out clears first/last frames and all image/video/audio references, and releases their preview URLs. Late uploads from an earlier account cannot restore media or overwrite the current upload's feedback or lock, even after switching back to that account. Generation with reference media rechecks the live account before sending the paid request; changed accounts require the user to review the cleared media first.

The video settings control shows the current aspect ratio, resolution and duration together. Its inline panel groups supported ratio cards, resolution choices, duration choices and declared audio state; models with fixed audio explain that constraint instead of offering a toggle. Duration choices use the selected resolution's declared menu when supplied; an absent entry cannot fall back to global durations. A 30-second option appears only after the model declares it. Switching models, resolutions or workflows visibly corrects incompatible selections before generation. Adaptive aspect ratio requires an image or video actually sent by the active workflow; retained hidden media and audio alone do not enable it. Excess references remain in the draft and block generation with a removal instruction rather than being silently truncated.

Saved works come from the artifact index across current and retained output roots, including custom directories and Windows paths. Manage their directory, names and recoverable deletion in the [Artifacts page](../ui-artifacts/README.md); the creation grid does not rewrite previous chat links.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [client entry](src/client/index.ts) provides the video mode in the desktop renderer. The image/video tabs select the existing keyed panels; the declared window-scoped [draft store](src/client/draft-store.ts) retains the video prompt, parameter picks, reference previews, result and busy state across panel remounts. It does not persist drafts to disk.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Creation content](../creation-content/README.md): published script cards and presets.
- [AI prompt writing](../ui-prompt-assist/README.md): writing and revision behavior.
- [Credits host](../../host/credits-index/README.md): media requests and local editing.
- [Web Client](../../../docs/subsystems/web-client.md): client composition.

<a id="model-experience"></a>
## Model Experience

### Video submission and prompt assistance

#### What the model sees

This plugin adds no tool or Session event. Explicit video generation submits the visible `prompt`, selected model settings and active workflow references to the media endpoint. AI prompt assistance is a separate explicit text/vision request using the current draft and all retained images.

#### Token effect

Generation follows the selected media model's accounting. The [shared assistant](../ui-prompt-assist/README.md) documents prompt-assistance accounting. Script previews and category filters use no model tokens.

#### KV Cache effect

The client owns no provider cache or model conversation. Script previews and category filters do not affect KV cache; explicit generation and prompt assistance use their respective provider-owned requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The host generation endpoint waits for a final artifact path; there is no client task queue, cancellation, publication or editable timeline. Audio reference uploads appear only when the selected model declares support. Output audio switches appear only for models that declare toggle support. The artifact list does not include original prompts or generation settings, so clips cannot restore them. Drafts survive mode changes within a window, but a reload resets them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
