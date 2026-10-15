# Image creation workspace

Reference for `@deepseek-ai/dsh-client-ui-imagegen`, the image mode of the desktop AI creation module. The [Web Client subsystem](../../../docs/subsystems/web-client.md) owns slot composition and rendering.

The package registers one AI creation sidebar entry and the `imagegen` main panel. Its image/video tabs select the sibling panel through layout callbacks. A registration-owned draft keeps the image prompt, selected model, parameters, reference selections, operation status and feedback across panel switches; it is not written to disk. Reference preview URLs belong to the plugin and are released when removed, trimmed by a model change, or unloaded.

Templates provide editable prompt briefs. Categories and search filter the actual brief catalog; picking a card never submits a request. Style chips append one style instruction once. The works grid lists existing generated image artifacts, supports original-image preview and download, and can upload a work as a new reference when the selected model accepts image inputs.

The existing Credits media catalog supplies every model and its accepted parameters. Model changes trim incompatible references and clear unsupported choices. Uploads accept PNG, JPEG and WebP files up to the existing host limit of 32 MiB. Reading a saved work and uploading it share one upload lock, which blocks generation across mode switches. Reference appends use the current selected model and remaining capacity. Generation and upload failures preserve the draft and release busy controls. A disconnected generation has an unknown outcome: the page asks the user to refresh works before submitting again and performs no automatic generation retry.

## Model Experience

### Image submission

#### What the model sees

On explicit submission, the existing Credits image-generation endpoint receives the user-edited prompt, selected model parameters and reference asset identifiers. Template selection, filtering, image preview and panel switching make no model request.

#### Token budget

The user controls the prompt and selected references. The chosen image provider owns input limits and token accounting; this package adds no conversation messages.

#### KV Cache effect

Submitting a prompt starts an independent provider-owned image request. This package does not own conversation context or provider caching.

## Known Limitations and Deferred Work

- Work artifacts have no saved prompt metadata, so a work can be used as a reference but cannot restore its original prompt or model settings.
- Templates describe image briefs. A detail-set brief does not create an automated multi-step workflow; output count remains limited by the selected model.
- There are no work deletion, favorite, publication or generation-cancellation actions because the existing host exposes none.
- Drafts survive mode switches during the current plugin lifetime only. Reloading the app clears them, and an interrupted request may continue upstream.
