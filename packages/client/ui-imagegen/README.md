---
description: "Prepare image prompts with published templates and AI writing, manage reference images, and generate or download account-owned works."
kind: "package-reference"
---

# Image creation workspace

English | [中文](README.zh.md)

## Summary

Create images from an editable prompt and model-supported references, with published templates and optional AI writing. Preview and download saved works, or reuse a work as reference material. Drafts survive mode switches during the current plugin lifetime. Generation uses the signed-in account and may continue upstream after a connection fails.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

API calls, template media and artifact previews retain the application public mount through [`appPath`](../ui-primitives/README.md#use-this-package); local blob previews retain their original URLs.

Use the image mode of the desktop AI creation workspace to prepare a prompt, choose the model's accepted inputs, and explicitly submit generation.

The **Image specifications** group always shows the selected model's declared choices, including pixel sizes, resolution tiers, count, quality and optional output settings. The same controls apply to text-to-image and image-to-image requests. Models with named resolution tiers do not acquire undeclared pixel-size or aspect-ratio choices. Switching modes retains the draft; switching models clears unsupported choices.

The injected creation-content catalog supplies published templates, category labels, style instructions, headings and prompt placeholders from the administration backend. Categories and templates follow their configured order; draft templates and disabled categories stay hidden. English content uses its Chinese text when no English translation is present. Real cover assets load from the creation asset route; absent covers remain text cards. Loading, empty and failed catalogs show their actual state, with an explicit retry after failure. There is no bundled business-content fallback. Selecting a template fills an editable prompt, and style chips append their configured suffix once; neither starts generation. The works grid lists existing generated image artifacts, supports original-image preview and download, and can upload a work as a material independently of model capabilities.

The prompt editor hosts the shared [AI prompt assistant](../ui-prompt-assist/README.md), passing its current text, all retained image materials and generation settings. A successful explicit writing request updates the main prompt directly and focuses the editor. Follow-up feedback rewrites that current text. While AI writing runs, uploads, generation and settings are locked, while the main prompt remains editable. A final comparison against the current prompt, account epoch, materials, settings and media-operation state prevents late results from replacing intervening changes. Writing does not submit an image-generation request.

Reference ownership stays in the window draft across panel remounts. The assistant receives parent references only after the live account matches that owner. Changing accounts or signing out clears reference selections and releases their previews. Uploads from an earlier account cannot append references, replace feedback or release a newer upload lock, including after switching back to the earlier account. Image generation with references rechecks the live account before sending a paid request; an account change clears the references and asks the user to review before generating again.

The material area groups the upload entry and all retained thumbnails above the prompt, including when the prompt is long. The existing Credits media catalog supplies every model and its accepted parameters, including separate resolution tiers where declared. Model changes retain materials and clear unsupported parameter choices. Materials accept up to six PNG, JPEG/JFIF, WebP, AVIF, GIF, BMP, TIFF, HEIC or HEIF images, including on text-only models. Each original may be at most 32 MiB; the host checks actual image bytes and converts them to model-supported PNG or JPEG. Animated images use their first frame. The normalized images share a 12 MiB total budget. The page retains accepted images, names each rejected file with its reason, and reports added, failed and converted counts; a failed upload does not stop later files in the batch. AI writing receives all materials. Image generation uses only the first images accepted by the selected model, or no image inputs for a text-only model; the page explains that distinction. Reading a saved work and uploading it share one upload lock, which blocks generation across mode switches. Appends use the current material count and byte budget. Upload failures and confirmed generation rejections preserve the draft and release busy controls. A disconnected generation retains its original submission and offers safe query recovery.

Accepted image and video tasks retain their available original project, operation, task and request IDs and show generating status while queued or processing. A temporary status-read, download or save failure preserves the task and earlier outputs. **Query original task** appears only when the Host admits the original receipt and reads and saves that existing task without submitting generation again. Pending or unknown submissions keep generation locked across page remounts; confirmed terminal rejection releases the lock. A submission without a task ID remains unconfirmed and asks the user to check the original record and billing. Failed reads and queries retain the lock, and the page never automatically resubmits generation.

Original-task admission blocks only paid generation. Users may prepare models, references, parameters and templates while no chat is selected or a previous task is unresolved; real uploads, generation and AI writing retain their input locks. Original task coordinates remain attached to their initiating chat and account when the draft changes.

Saved works come from the artifact index across current and retained output roots, including custom directories and Windows paths. Manage their directory, names and recoverable deletion in the [Artifacts page](../ui-artifacts/README.md); the creation grid does not rewrite previous chat links.

Select a workspace chat before generating. The request captures that exact chat and signed-in account, retaining a project with the prompt, material references, task and saved images. AI creation contains only the image and video tabs; open [Creation](../ui-creative/README.md) in the chat's right sidebar to manage its timeline, characters, materials and tasks. Artifact previews and reference reuse retain the originating workspace coordinate, including when different mounts contain the same path.

Generation and model-catalog failures use the observed failure code or HTTP status to distinguish network interruptions, timeouts, invalid inputs, permissions, explicit busy responses, service failures, model-service failures and local storage failures. Unknown failures leave the cause unconfirmed. Fetch transport failures ask users to check their network, VPN or proxy; arbitrary exceptions do not imply a network or server cause. Sign-in and product-credit failures keep their recovery actions; each rejected image keeps its filename and a safe format, size or conversion reason. The Host's three local reference validation/upload failures also retain their safe filename, reason and confirmation that generation was not submitted. Other response messages and codes are not rendered. Unknown or accepted generation outcomes retain original-task recovery, and failed paid requests are not automatically resubmitted.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [client entry](src/client/index.ts) registers one AI creation sidebar entry and the `imagegen` main panel. Its image/video tabs select the sibling panel through layout callbacks. A registration-owned [draft store](src/client/draft-store.ts) keeps the image prompt, selected model, parameters, reference selections, operation status, original-task receipts and feedback across panel switches; it is not written to disk. The page checks the account/chat-owned Host project listing before enabling generation, restoring pending-task protection after reload. Only a confirmed terminal original task releases a retained lock. Active original-task queries are polled while the page is visible; account changes and unmounting cancel their reads. Reference preview URLs belong to the plugin and are released when removed, their owner changes, or the plugin unloads.

Without retained project/operation coordinates, the composer restores invocations marked `source: 'ai-creation'` by the Host. Confirmed chat invocations do not lock the form; source-less legacy work remains protected unless a retained video-project id or tool-call origin establishes chat ownership. Once captured, exact original coordinates remain authoritative: missing records, failed reads and unknown outcomes retain protection; another pending task cannot replace the original, and only its confirmed terminal result releases the lock.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Creation content](../creation-content/README.md): published templates and presets.
- [AI prompt writing](../ui-prompt-assist/README.md): shared writing actions.
- [Credits host](../../host/credits-index/README.md): account-authorized media requests.
- [Web Client](../../../docs/subsystems/web-client.md): slot composition and rendering.

<a id="model-experience"></a>
## Model Experience

### Image submission

#### What the model sees

On explicit image submission, `/credits/api/image/generate` receives the user-edited prompt, selected model parameters and reference asset identifiers. AI prompt assistance is a separate, explicit request with the current draft and all retained image materials. Template selection, filtering, image preview and panel switching make no model request. Checking retained records reads the owned local creative-project listing. Querying an accepted task posts only the original session, project and operation coordinates to `/credits/api/creative/image/recover`; the Host queries that existing task without another generation POST.

#### Token effect

The user controls the prompt and selected references. The chosen image provider owns input limits and token accounting; this package adds no conversation messages.

#### KV Cache effect

Submitting a prompt starts an independent provider-owned image request. This package does not own conversation context or provider caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Earlier unassociated artifacts have no project metadata. New account/chat-associated requests retain their prompt and material references in Creation projects; the works grid does not restore composer settings automatically.
- Templates provide prompt text; output count and supported generation inputs remain limited by the selected model.
- The creation grid has no favorite, publication or generation-cancellation actions. File management belongs to the Artifacts page.
- Drafts survive mode switches during the current plugin lifetime only. Reloading the app clears the composer draft; pending-task protection is restored from owned Host records, and an interrupted request may continue upstream. An unknown record without a task ID cannot be queried or unlocked by this page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
