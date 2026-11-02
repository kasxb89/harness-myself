---
kind: upgrade-guide
description: "Chats with captured personal media preferences require a reader that understands media/request-selection."
---

# Read chats with personal media preferences

English | [中文](guide.zh.md)

## Change

Personal image and video preferences are stored separately from sign-in credentials, scoped to the backend URL and account ID. New chat submissions capture their choices in the required `media/request-selection` Session event. Changing a preference affects later submissions; accepted tasks and their recovery keep their original model and parameters. Explicit human requests take priority over saved defaults, and non-H3 price confirmation remains required.

The Session format version is unchanged. New readers accept existing chats without these events. Older readers refuse chats containing this unknown required event instead of silently discarding a choice that affects generation and billing. Clearing a saved preference does not remove events already committed to a chat. The [persistence acknowledgement](../../../persistence-changes/2026-11-01-chat-media-preferences.md) records both reader directions.

## Migration

1. Keep the existing Session directories and account files. No manual migration or credential reset is required.
2. Use the updated client to open a chat after personal media choices have been captured. Keep that client available before switching to an older build; older builds can still use separate chats without the required event.
3. Open the image or video control below the chat input, review current-account models and save the desired static parameters. Select “follow platform” to clear that modality's future preference. If a model has been disabled, select an available model or clear its preference; no replacement is charged automatically.
4. Update media-tool callers to use the effective `default_model_id` and `selected_parameters` from `list_image_models` or `list_video_models`. These fields remain available when `default_error_code` reports an incomplete specification. Correct `MEDIA_MODEL_MISMATCH` using that selected model instead of retrying another model's parameters. The display alias `mt-MiniMax-H3` keeps the original `MiniMax-H3` submission ID and is distinct from `ycapi-minimax-h3`.
5. Verify that an independent later request uses the saved choice while an already accepted generation retains its original task. A model-only preference with several complete specifications still needs an unambiguous specification before submission.
