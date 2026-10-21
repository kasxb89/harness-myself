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

The unified material entry accepts images and the selected model's declared MP4/MOV video and MP3/WAV audio inputs, including mixed batches. Missing browser MIME values use supported extensions, and the Host verifies actual bytes. Adding images from text mode selects reference mode where supported, otherwise, where frame input is supported, image mode with the first image as its first frame. Users can explicitly choose first and last frames from retained images. The image pool allows at least nine writing references independently of smaller generation limits; larger model-declared pools remain available. Original images accept up to 32 MiB; the Host normalizes supported formats, including HEIC, into PNG/JPEG previews and inputs, within 6 MiB per image and 12 MiB total. Animation and multipage inputs use their first frame. Video inputs accept 32 MiB each; audio inputs accept 15 MiB each and support playback. Active generation references total at most 48 MiB. Failed batches retain successful files, continue later files and name each failure. One upload or generation runs at a time. Generation executes once; uncertain outcomes retain the draft and previous result with an instruction to check saved clips. Previews remain valid while any retained material or frame owns them. Removing an image material also removes its frame bindings.

One compact Add media control below the prompt owns ordinary uploads. Uploaded materials appear next to it, and each media section lists retained cards without a duplicate uploader. Material images use a compact thumbnail grid with truncated names, first/last-frame badges and frame-selection actions on each card. Frame upload controls remain compact. Entering image or endpoint-frame mode selects a retained image as the first frame when none is selected; explicitly clearing or deleting it is respected across panel remounts. Automatic selection records its visit in the retained window draft and checks the current account owner and epoch before using live images. First/last-frame badges and pressed controls indicate only frames sent by the active workflow; reference mode keeps cached selections without marking them active. A visible summary states which materials the current generation will send. The generation action explains missing input or an active writing/upload operation. Upload failures distinguish the image count, converted per-image size and combined image size; combined-size failures report the retained and incoming MiB values.

The prompt editor hosts the shared [AI prompt assistant](../ui-prompt-assist/README.md). It receives the current prompt, video settings and all deduplicated first/last-frame and reference images, including images retained from another workflow. A visible notice explains that video and audio references are used for generation only. More than nine images disables writing without truncation. Successful explicit writing updates the main prompt directly and focuses it; feedback rewrites that text without starting video generation. While writing runs, upload, generation, workflow and settings controls are locked; the main prompt remains editable. A final comparison of prompt, account epoch, materials, settings and media-operation state rejects late results after intervening changes.

The window draft retains the reference account and upload epoch across panel remounts. Parent images reach AI writing only after the live account matches the reference account. Switching accounts or signing out clears first/last frames and all image/video/audio references, and releases their preview URLs. Late uploads from an earlier account cannot restore media or overwrite the current upload's feedback or lock, even after switching back to that account. Generation with reference media rechecks the live account before sending the paid request; changed accounts require the user to review the cleared media first.

The video settings control shows the current aspect ratio, resolution and duration together. Its inline panel groups supported ratio cards, resolution choices, duration choices and declared audio state; models with fixed audio explain that constraint instead of offering a toggle. Duration choices use the selected resolution's declared menu when supplied; an absent entry cannot fall back to global durations. A 30-second option appears only after the model declares it. Switching models, resolutions or workflows visibly corrects incompatible selections before generation. Adaptive aspect ratio requires an image or video actually sent by the active workflow; retained hidden media and audio alone do not enable it. Excess references remain in the draft and block generation with a removal instruction rather than being silently truncated.

Saved works come from the artifact index across current and retained output roots, including custom directories and Windows paths. Manage their directory, names and recoverable deletion in the [Artifacts page](../ui-artifacts/README.md); the creation grid does not rewrite previous chat links.

Select a workspace chat before generating. Requests retain the initiating chat and account even if the user switches chats while waiting. AI creation contains only the image and video tabs; open [Creation](../ui-creative/README.md) in that chat's right sidebar for the timeline, characters, materials, retained tasks and saved outputs. History playback and downloads preserve each artifact's workspace identity, including identical paths in different mounts.

Accepted image and video tasks keep their original receipt and show generating status while queued or processing. A temporary status-read, download or save failure preserves the task and earlier outputs. **Query original task** reads and saves that existing task without submitting generation again. Pending or unknown submissions keep generation locked across page remounts; a confirmed terminal rejection releases the lock. A submission without a task id remains unconfirmed and cannot be blindly resubmitted.

Generation, model-catalog and material server failures display localized busy copy without raw messages or codes. Sign-in, product-credit, cancellation, file validation and unknown paid outcomes retain their safe next steps. Upload failures still name the affected material, and no failed generation request is automatically repeated.

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

- The clip endpoint waits for a final artifact path; it has no client-side generation cancellation or publication action. Creation projects supplies the chat sidebar's editable timeline and retained task list, while earlier unassociated artifacts lack project metadata. The works grid does not restore composer settings automatically. Audio references and switches follow declared model support. Drafts survive mode changes within a window, but a reload resets them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
