---
description: "Follow chat image and video creation through saved characters, reference materials, storyboards, real media and editable shot revisions."
kind: "package-reference"
---

# Chat creation sidebar

English | [中文](README.zh.md)

## Summary

Follow image and video projects alongside the chat that creates them. Inspect saved character directions, registered reference materials, planned shots, generation states and actual output files. Stage a shot revision or redo in the chat draft, then review and send it yourself. A saved video remains separate from unverified speech, lip and subtitle synchronization.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Open **Creation** in the chat’s existing right sidebar. The first actual retained project opens its tab once; later progress does not reopen a tab you closed. Switching chats changes the project scope. Characters, materials, shots and outputs have separate tabs, with longer directions and material references folded into details.

Only owner-authorized files appear as previews. Video frame grids contain extracted frames with actual timestamps; missing or failed frame extraction stays visible while the original file remains downloadable. File completion and synchronization verification are independent: saved videos display speech, lip and subtitle timing as unverified.

**Edit character**, **Rework asset** and **Edit shot** share a dialog for your directions. **Redo shot** inserts the existing project and shot identities into an editable chat draft. Every action preserves the normal send step and adds no paid request itself; sending the draft can execute generation and use credits. Character and material revisions preserve their plan identities and check real references and model support. An image material with no source can first be generated from its description; an unreadable or non-image source requires an input or workflow check. Material cards show actual saved outputs, and character cards preview only the images of their registered reference materials. A busy or changed draft refuses insertion without replacing the user’s text. Image projects label their output section **Images**.

The shipped Web application composes this browser plugin. Its Loader configuration controls visible active-project supervision:

| Field | Default | Meaning |
|---|---|---|
| `pollIntervalMs` | `2000` | Active-project read interval, from 500 to 60000 milliseconds. |

Read failures preserve the last available project data with a retry action. Hiding an opened tab or application stops its polling. Before the first project exists, a logged media call supervises reads until an actual record becomes available; empty responses do not invent a plan or progress. Tool results and turn completion stop empty supervision. Session tool transitions, reopening and connection resets request the current full listing. Signing out clears every retained project snapshot immediately; results from the earlier account cannot repopulate it.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one ordinary right-sidebar tab and its icon/title through the existing slot registry. A registration-owned [controller](src/client/controller.ts) supervises cancellable, session-addressed reads. Components consume its observable through a framework-bound hook; they do not subscribe to transport or scan the conversation transcript. The [transport parser](src/client/api.ts) validates the Host projection and accepts only the controlled project-media route.

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

Viewing, refreshing, switching sections and downloading files make no model request. Character, material and shot revisions insert localized text, the original plan/member identifiers and the user’s directions into the normal chat draft. The model sees that text only after the user sends it; the draft requests `get_creation_plan` followed by `update_creation_plan`, preservation of unrelated members, and supported generation using real references against the identified project.

#### Token effect

The next user-submitted message includes the staged directions. This package adds no hidden conversation messages or background model calls.

#### KV Cache effect

The ordinary conversation submission owns caching. Reading progress and previewing files do not change conversation context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The sidebar displays retained project facts and real files, with these limits:

- Earlier conversations without registered creation plans show no reconstructed storyboard; prose is not parsed to invent one.
- Reference directions do not guarantee that a provider preserves character appearance, spoken dialogue or lip timing.
- Synchronization remains unverified until the resulting video is inspected; a saved file is not a verification receipt.
- Preview extraction can fail independently of generation. The original saved output remains available.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
