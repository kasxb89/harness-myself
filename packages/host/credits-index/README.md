---
description: "Authorize local account, balance and media requests, inspect hourly usage, assist prompt writing, and compose recoverable video projects."
kind: "package-reference"
---

# Credits host

English | [中文](README.zh.md)

## Summary

Use the signed-in product account for balance, recharge, usage analysis and media generation. Prompt assistance prepares editable image or video briefs without submitting media generation. Workspace video projects plan supported clips, generate them in order, and publish a locally verified final video. Paid requests use the current account; cancellation cannot guarantee that accepted upstream work stops billing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The credits host relays account, balance, recharge and media operations through the origin-checked local `/credits` routes. The deployed API root is `https://8.133.202.230/harness`; model requests use its `/v1` suffix. The complete prefix is retained for every upstream request. This IP's root `/api` and `/v1` paths are rejected, redirects are not followed, and ordinary HTTPS certificate checks remain enabled.

### Account session

Phone challenge and login use `/api/user/phone/challenge` and `/api/user/phone/login` beneath the configured root. Login provides the short-lived management `access_token`, rotating refresh cookie and account-owned `relay_key`. Only that relay key authorizes model requests. The host stores these credentials privately, binds the session to its backend root, and waits for one shared renewal before using an expiring management token. Refresh and logout declare the backend's Origin. The host provides live `harnessAccount` authorization to the product model route; stored or environment credential references cannot replace a valid session. Logout removes this authorization immediately; a concurrent old refresh cannot restore it. Moving a stored session to another backend requires phone sign-in again.

### Chat model refresh

Each product-route model listing first awaits the current account's `harnessAccount.refreshModels` result. The Host reads `/v1/models` with that account's relay key, excludes declared media generators, and synchronizes nonempty chat results before the adapter reads its configuration. Concurrent reads share one operation. An empty successful result exposes no chat models even if an older profile remains configured; unavailable reads become catalog failures instead of showing old models as currently available. Other provider routes keep their existing listing behavior.

Startup and the 60-second timer use the same refresh operation. Login changes and logout cancel older discovery; commit checks the login generation, stored session identity, backend and expiry. Disposal cancels and awaits outstanding discovery. The UI can request a fresh catalog without waiting for the timer. Published pricing still describes media parameters, while the account's model endpoint determines its chat list; a declared or selected model can still fail upstream authorization or billing validation.

### Recharge

`POST /credits/api/recharge/wechat` accepts an integer `amount` in yuan and creates one Native order with the account's access token. The response exposes `outTradeNo`, `amount`, converted `points`, `expiresAt` and `qrCodeDataUrl`; raw quota is not a points amount. Conversion requires current status parameters before order submission. Unknown submission outcomes are reported without an automatic second order.

`GET /credits/api/recharge/wechat/order?outTradeNo=...` queries that same account's order. The host forwards the backend status without aliases and adds converted points. The client reports unknown states for manual checking instead of declaring success. Payment callbacks go directly to the deployed API, which owns crediting the account; the product only refreshes the live balance after a confirmed payment.

### Usage analysis

`GET /credits/api/usage?start=<seconds>&end=<seconds>` returns the signed-in account's hourly model aggregates. Both parameters are inclusive positive Unix-second integers; the complete interval may contain at most 31 days. The client chooses its display timezone before converting natural days to seconds. Duplicate parameters, account selectors, and other query parameters are rejected.

Success uses the credits envelope `{ ok: true, payload: ... }`. The payload contains `rows`, `start`, `end`, `asOf` (ISO read time) and `delayMinutes: 0`. Rows contain `timestamp`, `model`, `billingRecords`, `consumedPoints` and `totalTokens`. The host groups consumption log records by hour and model; the zero delay field describes the absence of the previous aggregate-export wait and does not guarantee immediate appearance of new charges. Consumption records are not request counts, and separately logged refunds are not subtracted.

The host verifies `/api/user/self` against the product session, then reads every page of `/api/log/self?type=2&p=1&page_size=100` for the selected interval. It validates pagination, account identity, quota and token fields, and the JSON-string `other` field. Failed, incomplete or inconsistent reads never produce partial rows. No administrator token, account search or deployment credential substitutes for the signed-in account.

A live `/api/status` read supplies `quota_per_unit` and `usd_exchange_rate`. Points use `quota / quota_per_unit × usd_exchange_rate × 1000`; neither backend parameter has a hardcoded fallback. Missing or invalid conversion settings and unavailable or invalid source data return `{ ok: false, code, message }` without a replacement zero. The client owns visible error reporting and retry and retains the previous display while a read is unavailable.

Usage reads share the local-origin guard, `timeoutMs` and the complete `newApiBaseUrl` deployment prefix. They use only the current account's access token. The product does not read cached quota or a different account's balance when the service is unavailable.

### Prompt assistance

`POST /credits/api/prompt/assist` accepts exactly `{ accountId: string, kind: 'image' | 'video', prompt: string, instruction: string, references: string[], generation: Record<string, string> }`. The host compares `accountId` with the live product session and returns `ACCOUNT_CHANGED` before any model lookup when they differ; this field never becomes model input. The current draft, requested revisions, and generation parameter summary become model input. PNG, JPEG, and WebP references must be existing local `ma_` assets; arbitrary URLs, video, and client-selected routing or credentials are rejected. Images are inlined as chat image content. A successful credits envelope contains `{ prompt, model }` in `payload`; failure contains a stable `code`, never an upstream body or exception. The client writes successful assistance directly into the editable creation prompt after checking its source draft and account; an unsuccessful request leaves that draft intact. Assistance does not submit a media generation.

Configure `promptAssistantModel` for text-only assistance and `promptAssistantVisionModel` for assistance with images. Both default to empty and accept model identifiers of at most 256 non-whitespace characters. Missing configuration is an explicit `PROMPT_ASSIST_NOT_CONFIGURED` failure. Vision support is an operator declaration, never inferred from a model name or absent catalog metadata. Before each completion, the host checks the selected model against `/v1/models` using only the current account's relay key, rejecting missing models and entries declared as image/video generators. It then calls `/v1/chat/completions` with the same key. An expired product session is cleared first; missing sign-in or relay credentials stop the request. The deployment catalog key is never a fallback. Background access-token renewal preserves the existing relay only after the upstream response confirms the same account ID; another or missing ID leaves the stored session untouched.

Request JSON is capped at 32 KiB; drafts at 7,000 characters; revision feedback at 2,000; parameter summaries at 16 string entries with 64-character keys and 256-character values. At least a draft, feedback, or reference is required. Up to six distinct references may total 15 MiB, with a 6 MiB per-image cap; MIME and image signatures must match. Completion bodies and account catalogs are capped at 64 KiB, final prompts at 7,000 characters, and completions at 2,048 tokens. `promptAssistantTimeoutMs` covers the complete operation independently of other API deadlines; it defaults to 60,000 ms and accepts integer values from 1 to 120,000 ms; disconnect or plugin disposal cancels provider work, and disposal awaits settlement. Automatic provider retries are absent. After a completion is dispatched, timeout, transport failure, cancellation, or an upstream error returns `PROMPT_ASSIST_RESULT_UNKNOWN`: the result is unknown and billing may have occurred. Invalid completion data likewise reports possible billing; users should inspect usage before deciding to retry. Catalog-stage failures have not sent a completion.

Before a model call, the host saves `stateDir/prompt-assists/<random-request-id>/request.json` with the account ID, selected model, token limit, exact system/user text, and reference metadata. Content-addressed image files under `prompt-assists/references` retain immutable bytes once per SHA-256 digest; ordinary uploads may overwrite an asset ID and are therefore insufficient for reconstruction. Directories use `0700`, files `0600` and exclusive creation. `outcome.json` stores only the validated candidate or a safe failure code, together with whether a completion was dispatched. Credentials and raw upstream responses are excluded. Input-record failure prevents sending; outcome-record failure returns `PROMPT_ASSIST_RESULT_STORAGE_FAILED`, indicating possible billing without an available candidate. A crash can leave a request without an outcome; records persist until an operator removes them, with no automatic retention cleanup. This standalone media workflow adds no Session format or agent-loop behavior.

### Published creation content

`GET /credits/api/creation/content` relays the deployed administration document as `{ ok: true, payload }`. `GET` and `HEAD /credits/api/creation/assets/:id` relay immutable `cc_` content-hash images and video, including single byte-range reads. These origin-checked reads use `newApiBaseUrl` and `timeoutMs`, send no account or deployment credential, reject upstream redirects and unexpected MIME types, and cap documents at 5 MiB and media at 100 MiB. Transfers stop on peer disconnect or plugin disposal; disposal awaits settlement. Errors expose only `CREATION_CONTENT_UNAVAILABLE`, never an upstream body. The [creation content reader](../../client/creation-content/README.md) owns document validation, refresh and consumer state.

### Video capabilities and references

Video menus read explicit `seconds` or `duration` declarations from public pricing `parameters` (a field map or JSON Schema `properties`), then `billing_usage_schema`. Numeric enums or finite `minimum`/`maximum` ranges select whole seconds from 1 to 3600 and override the model table; exclusive bounds and `multipleOf` further restrict the menu. Missing, malformed or unbounded declarations retain the known model limits; billing examples never grant durations or additional reference slots. Resolution enums and constants follow the same live priority. The current H3 response only declares a numeric seconds field without bounds, so its known 4–15-second menu remains. A model appearing in public pricing does not establish that a particular account can generate with it.

A declared `oneOf` pairs `properties.resolution.const` or `.enum` with bounded `properties.seconds` or `.duration`. The resulting `durationByResolution` menus govern both panel requests and project planning; missing resolution keys are unavailable, and a resolution must be selected. For example, a producer may explicitly publish one branch for 480P/768P at 4–30 seconds and another for 2K at 4–15 seconds. This describes supported parsing, not a declaration that the running API or an unspecified upstream supports those combinations. The Host rejects unsupported combinations and fractional or nonnumeric durations before model submission.

Local `/credits/api/assets` accepts PNG/JPEG/WebP images, MP4/MOV video and MP3/WAV audio with matching MIME and file signatures. Per-file limits are 6 MiB for images, 32 MiB for video and 15 MiB for audio; all images in one generation total at most 12 MiB and all reference bytes total at most 48 MiB, with the complete encoded generation request capped at 64 MiB. Audio is exposed only where the selected model declares audio-reference slots. H3 sends every reference in one complete `metadata.content` array. Frame references cannot mix with H3 general references. Adaptive ratio requires an actual image or video input. These checks do not decode the complete media or establish upstream generation capability.

### Local video editing

The project editor uses the Desktop-owned `DSH_VIDEO_RUNTIME_ROOT` directory and never searches PATH. It verifies both executables and an actual H.264/AAC encode in the selected output directory before paid generation, and refuses a read-only or escaping output tree. Every process runs through the current session’s subprocess provider and resolved sandbox policy, without shell interpolation. Inputs must be regular files inside the workspace or exact private clip directories already authorized by the project owner; private clip paths reject symbolic links. For current chat attachments stored outside the workspace, the model first copies the read-authorized attachments into the workspace through existing file tools. Protocol access is restricted to local files and pipes.

Editing preserves original clips, applies explicit start/end trims, fits each frame with padding inside the first clip’s canvas (or an explicit deployment override), rounded to even dimensions, converts to the configured frame rate, and normalizes audio to stereo 48 kHz. Missing audio becomes silence. Clips use hard cuts; this editor does not add transitions, subtitles or music. An optional final duration trims the combined sequence and rejects insufficient footage. FFprobe checks the output duration before an exclusive, atomic same-volume publication; an existing destination is never replaced. Cancellation and deadlines terminate and await the managed process range before temporary-file cleanup. A failed edit publishes no candidate; any completed original clips remain available for a later editing attempt.

<a id="video-projects"></a>
### Video projects

Workspace chat can create a finished video longer than the selected model's single-clip limit through `generate_video_project`. The planner first minimizes billable clip count, then surplus seconds: a 40-second request uses `15 + 15 + 10` when those values exist, or three fixed 15-second clips trimmed to 40 seconds. It validates every shot request and the local editor before the first paid submission. Optional shot prompts must match the planned clip count; uploaded reference ids and readable workspace media are checked through the current session. Generation uses only the signed-in account's relay credential and checks the captured account and login before each submission. Sign-out, expiry, or login change stops further charges.

Projects run as ordinary owned background jobs. The tool returns canonical `job_id`, `project_id`, and `plan_seconds`; existing job tools report progress and cancellation. Final success contains only independently verified, saved `final_path` and clip paths. The agent presents the final file through the existing `present` tool and a clickable artifact link. A local cancellation stops subsequent submissions and local work; an already accepted upstream task may continue running and billing because the relay exposes no cancellation operation.

Private owner-only records under `stateDir/video-projects/<project_id>/manifest.json` retain the account id, non-secret login fingerprint, calling chat and workspace, exact brief and prepared requests, ordered plan, accepted task ids, saved clip paths, and terminal outcome. Atomic replacement precedes each submission and follows each accepted task and saved clip; credentials and raw upstream responses are excluded. Clip downloads remain in the private project cache; only sandboxed local editing publishes the final file into `videoProjectOutputDirectory` inside the workspace. Records and media have no automatic retention cleanup. `video_project_status` authorizes reads by account, chat, and workspace. A process restart leaves retained records rather than a fictional live job; explicit `resume_video_project` reuses saved clips and queries known task ids before any never-submitted remainder. A submission without a persisted task id is an unknown, possibly billed outcome and is never automatically resubmitted; failed provider tasks likewise require a new explicit project or editing the retained clips.

Configure `videoProjectMaxSeconds` (default 300), `videoProjectMaxSegments` (32), `videoProjectPollIntervalMs` (6000), `videoProjectTaskTimeoutMs` (900000), `videoProjectDownloadMaxBytes` (536870912), `videoProjectReferenceMaxBytes` (20971520 per local reference), and workspace-relative `videoProjectOutputDirectory` (`artifacts/videos`). Complete records, including reserved task and path metadata, must fit 64 MiB before generation starts. These limits apply before paid work. Exact generation continuity depends on the provider; the pipeline supplies ordered shot prompts and shared references, but does not claim identity consistency or unseen transitions that the model has not generated.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [host entry](src/index.ts) connects local HTTP routes to account-authorized upstream operations. [Prompt assistance](src/prompt-assist.ts) owns candidate generation, while [video projects](src/video-project.ts) retain the ordered generation and recovery state and the [local editor](src/video-edit.ts) owns subprocess composition. The browser panels share these host operations rather than handling upstream credentials.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Webserver](../webserver/README.md): HTTP request carrier.
- [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-credits-index): accepted deployment fields.
- [Balance and usage](../../client/ui-credits/README.md): account-facing panels.
- [Creation content](../../client/creation-content/README.md): published content validation.

<a id="model-experience"></a>
## Model Experience

### Usage analysis

#### What the model sees

Usage analysis through `/credits/api/usage` is a browser-only read and contributes no model input.

#### Token effect

Usage reads make no model request and consume no model tokens.

#### KV Cache effect

Usage analysis does not change model context or KV cache.

### Prompt assistance

#### What the model sees

Prompt assistance makes one non-streaming chat completion; its system instructions and user text treat drafts, feedback, parameters, and images as untrusted reference material. The model returns a plain candidate prompt. Each revision sends the current edited candidate and new feedback rather than an implicit conversation history. Model-visible inputs and validated results remain reconstructable from the private standalone records described above.

#### Token effect

Each writing or revision request is billed to the current account and limits completion output to 2,048 tokens. Draft text, feedback, parameters and any reference images contribute input usage.

#### KV Cache effect

Each explicit request supplies its own current draft and feedback without an implicit conversation history. This standalone workflow owns no provider cache.

### Video projects and editing

#### What the model sees

The video tools, including `generate_video_project`, add planning, local editing, durable status, and explicit recovery instructions to the model context. Shot prompts come from the logged tool input and the saved ordered brief. Existing job tools expose progress and final paths through their normal logged results. The video project records retain exact generation requests without changing the Session format or agent loop.

#### Token effect

Tool declarations and logged results contribute ordinary agent-context tokens. The tools make no extra chat-completion call; paid video-model calls follow the persisted clip plan.

#### KV Cache effect

Tool declarations and logged results follow ordinary Session request handling. Video generation and local editing add no implicit chat history and own no provider cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The source groups records by hour and normally flushes them every five minutes. These aggregates cannot provide exact request timestamps, refund-adjusted net spending, per-token direction, or a live balance ledger. Usage responses are capped at 100,000 source rows; exceeding the cap is a visible failure.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
