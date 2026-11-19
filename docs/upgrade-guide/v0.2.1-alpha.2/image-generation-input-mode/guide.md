---
kind: upgrade-guide
description: "Image editing requests must carry their actual references instead of falling through to text-to-image generation."
---
# Declare the input mode for image generation

English | [中文](guide.zh.md)

## Change

`generate_image` accepts optional `generation_mode` with `text-to-image` or `image-to-image`. Without it, existing callers still infer editing from nonempty `reference_images`. An explicit editing mode or the current human request's affirmative “图生图” requires actual references before submission; missing references no longer fall through to paid text generation. Explicit text mode with generation references is a parameter conflict. Reference images do not count merely because an older chat contains them.

`list_image_models` publishes `generation_modes` and the applicable edit specifications. A standard edit-only route offers only image editing. A custom image route without a supported reference protocol cannot advertise or silently discard generation references. Editing uses the compatible specification subset before filling omitted dimensions.

## Migration

1. Read `list_image_models` for the exact selected model and retain the user's explicit choice. For editing, use its editing specifications and pass authorized source images in `reference_images`; set `generation_mode` to `image-to-image` when the input mode is explicit.
2. If a pre-submission result reports `IMAGE_REFERENCE_REQUIRED`, supply the intended original image. Do not remove references or change the request to text generation merely to bypass the error.
3. Confirm the accepted request retains the intended mode and references. Pending or unknown original tasks continue through their existing query/recovery tools; this change does not authorize resubmitting them. Existing stored tasks and sign-ins require no migration.
