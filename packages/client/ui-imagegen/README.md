# Image creation workspace

English | [中文](README.zh.md)

Reference for `@deepseek-ai/dsh-client-ui-imagegen`, the image mode of the desktop AI creation module. The [Web Client subsystem](../../../docs/subsystems/web-client.md) owns slot composition and rendering.

The package registers one AI creation sidebar entry and the `imagegen` main panel. Its image/video tabs select the sibling panel through layout callbacks. A registration-owned draft keeps the image prompt, selected model, parameters, reference selections, operation status and feedback across panel switches; it is not written to disk. Reference preview URLs belong to the plugin and are released when removed, their owner changes, or the plugin unloads.

The injected creation-content catalog supplies published templates, category labels, style instructions, headings and prompt placeholders from the administration backend. Categories and templates follow their configured order; draft templates and disabled categories stay hidden. English content uses its Chinese text when no English translation is present. Real cover assets load from the creation asset route; absent covers remain text cards. Loading, empty and failed catalogs show their actual state, with an explicit retry after failure. There is no bundled business-content fallback. Selecting a template fills an editable prompt, and style chips append their configured suffix once; neither starts generation. The works grid lists existing generated image artifacts, supports original-image preview and download, and can upload a work as a material independently of model capabilities.

The prompt editor hosts the shared [AI prompt assistant](../ui-prompt-assist/README.md), passing its current text, all retained image materials and generation settings. A successful explicit writing request updates the main prompt directly and focuses the editor. Follow-up feedback rewrites that current text. While AI writing runs, uploads, generation and settings are locked, while the main prompt remains editable. A final comparison against the current prompt, account epoch, materials, settings and media-operation state prevents late results from replacing intervening changes. Writing does not submit an image-generation request.

Reference ownership stays in the window draft across panel remounts. The assistant receives parent references only after the live account matches that owner. Changing accounts or signing out clears reference selections and releases their previews. Uploads from an earlier account cannot append references, replace feedback or release a newer upload lock, including after switching back to the earlier account. Image generation with references rechecks the live account before sending a paid request; an account change clears the references and asks the user to review before generating again.

The existing Credits media catalog supplies every model and its accepted parameters. Model changes retain materials and clear unsupported parameter choices. Materials accept up to six PNG, JPEG or WebP images, each at most 6 MiB and together at most 12 MiB, including on text-only models. AI writing receives all materials. Image generation uses only the first images accepted by the selected model, or no image inputs for a text-only model; the page explains that distinction. Reading a saved work and uploading it share one upload lock, which blocks generation across mode switches. Appends use the current material count and byte budget. Generation and upload failures preserve the draft and release busy controls. A disconnected generation has an unknown outcome: the page asks the user to refresh works before submitting again and performs no automatic generation retry.

## Model Experience

### Image submission

#### What the model sees

On explicit image submission, the existing Credits image-generation endpoint receives the user-edited prompt, selected model parameters and reference asset identifiers. AI prompt assistance is a separate, explicit request with the current draft and all retained image materials. Template selection, filtering, image preview and panel switching make no model request.

#### Token budget

The user controls the prompt and selected references. The chosen image provider owns input limits and token accounting; this package adds no conversation messages.

#### KV Cache effect

Submitting a prompt starts an independent provider-owned image request. This package does not own conversation context or provider caching.

## Known Limitations and Deferred Work

- Work artifacts have no saved prompt metadata, so a work can be used as a reference but cannot restore its original prompt or model settings.
- Templates provide prompt text; output count and supported generation inputs remain limited by the selected model.
- There are no work deletion, favorite, publication or generation-cancellation actions because the existing host exposes none.
- Drafts survive mode switches during the current plugin lifetime only. Reloading the app clears them, and an interrupted request may continue upstream.
