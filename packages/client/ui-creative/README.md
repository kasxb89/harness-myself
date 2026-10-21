---
description: "Manage projects in the chat sidebar with editable storyboard timing, character references, materials, tasks and saved media."
kind: "package-reference"
---

# Creation projects

English | [中文](README.zh.md)

## Summary

Manage image and video projects in the chat's right sidebar, including works initiated from AI creation. Edit storyboard timing and order, maintain characters and reference materials, and inspect retained tasks and actual outputs. Planning changes save without a model request. Generation and revisions use ordinary chat drafts and existing native workflows. A saved video remains separate from unverified speech, lip and subtitle synchronization.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Open **Creation** in the chat's existing right sidebar. Each chat retains its selected project and shot, including projects associated with that chat by AI creation. The first actual project opens its sidebar tab once; later progress does not reopen a tab you closed. Characters, materials, shots and tasks have separate sections, with longer directions folded into details.

The thumbnail timeline shows planned start and end times. Select a shot to inspect it, move it earlier or later, and edit its title, duration, camera, scene, action, prompt, dialogue, subtitles and character/material associations. Character and material cards support search, creation and editing; material uploads retain a real local reference identifier. Saving is free and checks the plan revision. A conflicting edit preserves the form and asks for refresh; running linked items cannot be rewritten. Requested timing and the latest submitted duration are separate facts.

Material uploads accept common image formats, including HEIC, TIFF and animated GIF. The host converts images to model-supported PNG/JPEG and returns the converted size and authorized preview; animated or multipage sources use their first frame. The editor identifies a failed file and its reason while retaining the previous material, and permits choosing the same file again. Each material editor uploads one source at a time.

The task section filters retained invocation states and output kinds, shows completed shot counts and opens real saved reference images, clips and final files. Failed and unknown work remains visible beside earlier usable outputs. Counts describe committed local records, not estimated upstream rendering percentages.

Image tasks retain their submission receipt and show **Query original task** only when the Host permits querying an existing task identifier. This action retrieves the original task without submitting generation again; an accepted query resumes visible progress reads. Accepted but unconfirmed results remain distinct from submissions with no queryable identifier. The latter retain conservative guidance to check the original task and billing without resubmitting. Receipt details show retained task and request identifiers; they do not expose credentials or backend addresses.

Only owner-authorized files appear as previews. Video frame grids contain extracted frames with actual timestamps; missing or failed frame extraction stays visible while the original file remains downloadable. File completion and synchronization verification are independent: saved videos display speech, lip and subtitle timing as unverified.

**Edit character**, **Rework asset** and **Edit shot** share a dialog for your directions. **Redo shot** inserts the existing project and shot identities into an editable chat draft. Every action preserves the normal send step and adds no paid request itself; sending the draft can execute generation and use credits. Character and material revisions preserve their plan identities and check real references and model support. An image material with no source can first be generated from its description; an unreadable or non-image source requires an input or workflow check. Material cards show actual saved outputs, and character cards preview only the images of their registered reference materials. A busy or changed draft refuses insertion without replacing the user’s text. Image projects label their output section **Images**.

The shipped Web application composes this browser plugin. Its Loader configuration controls visible active-project supervision:

| Field | Default | Meaning |
|---|---|---|
| `pollIntervalMs` | `2000` | Active-project read interval, from 500 to 60000 milliseconds. |

Read failures preserve the last available project data with a retry action. Hiding an opened tab or application stops its polling. Before the first project exists, a logged media call supervises reads until an actual record becomes available; empty responses do not invent a plan or progress. Tool results and turn completion stop empty supervision. Session tool transitions, reopening and connection resets request the current full listing. Signing out clears every retained project snapshot immediately; results from the earlier account cannot repopulate it.

Failed task cards show localized busy copy and guidance to inspect existing results before resubmission; task diagnostics are not rendered as codes. A saved file that could not enter the artifact library keeps its separate local-storage recovery message and remains previewable.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one ordinary right-sidebar tab. A registration-owned [controller](src/client/controller.ts) supervises cancellable, session-addressed reads, free revision-checked saves and reference uploads. Framework-bound hooks supply its observable to the tab. The [transport parser](src/client/api.ts) validates project, task and media ownership; the tab does not scan conversation prose to invent state.

The authoritative Credits account observable owns sign-in state. Account changes, conversation switches and application visibility cancel superseded reads; account epochs contain late responses. Tab lifetimes own visibility holds, while the controller owns polling and waits for its reads during unload. Draft outcomes render through a shell toast that outlives the requesting tab.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Credits Host](../../host/credits-index/README.md): retained creation plans and authorized generated media.
- [Right sidebar](../ui-sidebar-right/README.md): navigation, tab ownership and docking.
- [Conversation](../ui-conversation/README.md): current-chat input and standard Session hooks.
- [Artifacts](../ui-artifacts/README.md): saved-file management and workspace browsing.

<a id="model-experience"></a>
## Model Experience

### Creation revision drafts

#### What the model sees

Viewing, refreshing, querying an original image task, free field edits, uploads and downloading files make no model request. AI revisions and shot redo insert localized text, exact plan/member identifiers and the user's directions into the normal chat draft. The model sees these after the user sends them; the draft requests `get_creation_plan`, preservation of unrelated members and existing native generation/editing tools. Timeline and reference changes become model input through the logged plan read rather than a hidden message.

#### Token effect

The next user-submitted message includes the staged directions. This package adds no hidden conversation messages or background model calls.

#### KV Cache effect

The ordinary conversation submission owns caching. Reading progress and previewing files do not change conversation context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The sidebar displays retained project facts and real files, with these limits:

- Earlier conversations without registered creation plans show no reconstructed storyboard; prose is not parsed to invent one.
- Unknown image submissions without a retained task identifier cannot be queried from this interface; a request identifier alone does not authorize resubmission.
- Reference directions do not guarantee that a provider preserves character appearance, spoken dialogue or lip timing.
- Synchronization remains unverified until the resulting video is inspected; a saved file is not a verification receipt.
- Preview extraction can fail independently of generation. The original saved output remains available.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
