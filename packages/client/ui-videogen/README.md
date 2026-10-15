# Video creation

English | [中文](README.zh.md)

This browser plugin provides the video mode of the shared AI creation entry in the desktop renderer. The image/video tabs select the existing keyed panels; the declared window-scoped store retains the video prompt, parameter picks, reference previews, result and busy state across panel remounts. It does not persist drafts to disk.

The composer offers text, image, first/last-frame and reference workflows only where the existing media catalog declares support. Hidden workflow media stays in the draft and is excluded from generation requests. First/last-frame mode requires both images. Changing models removes references exceeding the new limits, releases their previews and asks the user to review the retained files. Camera-script cards have category filters and an editable preview; applying a script appends text and does not submit a request. My clips lists real saved video artifacts, with playback and download.

The existing session, catalog, asset, generation and artifact routes remain unchanged. Uploads accept non-empty files up to the host's 32 MB limit. A failed batch retains files already uploaded, reports the failure and restores controls. The composer permits one upload or generation operation at a time. Generation requests execute once; a transport failure retains the draft and previous result and tells the user to inspect saved clips before submitting again. Preview URLs remain valid across mode changes and are released on removal, replacement or plugin disposal.

## Model Experience

This plugin adds no model prompt, tool or Session event. Only explicit generation submits the visible prompt, selected model settings and active workflow references to the existing media endpoint. Script previews and category filters use no model tokens or KV cache.

## Known Limitations and Deferred Work

The host generation endpoint waits for a final artifact path; there is no client task queue, cancellation, publication or editable timeline. Audio reference uploads are omitted because the current asset route does not accept audio. Output audio controls appear only for models that declare them. The artifact list does not include original prompts or generation settings, so clips cannot restore them. Drafts survive mode changes within a window, but a reload resets them.
