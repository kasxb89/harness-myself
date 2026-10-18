---
description: "One artifact library for saved outputs and registered workspace files with recoverable file management."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-artifacts

English | [中文](README.zh.md)

## Summary

Find saved outputs and files from registered local workspaces in one Artifacts library. Files remain in their actual Host directories and support previews and file management. Workspace contents include existing files as well as new outputs; listing a file does not attribute it to a Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-client-ui-artifacts` in the browser roster with the slot and locale services. Pair it with [artifacts-index](../../deliverables/artifacts-index/README.md) for authenticated file access and the workspace registry for mounted directories. `pollIntervalMs` controls foreground library refresh (default 5000 ms; accepted range 1000–60000 ms). The visible library rechecks files, save-directory settings and recovery entries without overlapping requests. Hidden or unmounted pages cancel their pending refresh and stop polling; refresh failures retain the existing listing.

The library combines managed output roots and registered local workspaces, including nested files created by chat tools or shell commands without Git or a `present` call. Select Save directory to view or change the save location in a dialog; the path and settings remain hidden until the dialog opens. The dialog accepts an existing absolute path and offers the native folder picker when available. Saving a directory affects future media generation, keeps older files visible, and does not move them. Workspace registration does not change this preference or add its root to the saved output roots.

Search and type filters apply to the combined returned listing. There is no separate workspace tab or directory navigator. Removing a workspace revokes that source's access. A source that cannot be scanned displays a localized warning while other files remain usable; a partial traversal displays a separate notice rather than reporting an exhaustive library.

When the listing is partial, Find unlisted files opens a compact source and folder dialog. Browse a retained output directory or registered workspace one level at a time, then select a file to open it in the library preview. This reaches files outside the initial count or depth limit without adding a second main view or changing save-directory permissions. Automatic refresh retains these selections while their source remains authorized; explicit Refresh clears unreturned discoveries and prompts a new folder lookup for current metadata.

File rows show the name and metadata; select a file to preview its contents, rename it or move it to the recovery area. In the preview details, expand File location to see its complete Host path; this section is collapsed by default. File changes use the selected size and modification time; a changed or conflicting file requires review instead of overwriting. Restore entries from the recovery area, including after reopening the app. Workspace-file recovery requires its original canonical workspace directory to be registered again. Destructive actions require confirmation; uncertain mutation outcomes require refreshing before trying again. When the serving Host provides the capability, the page offers revealing the selected file in that Host's file manager.

Previews follow the filename extension. PDF uses the shared PDF.js reader with continuous pages, selectable text and zoom. DOC/DOCX, XLS/XLSX and PPT/PPTX use the authorized Host's local `officeToPdf` provider for read-only PDF pages; no source file is uploaded to an external document viewer. Markdown uses the shared `MarkdownText` renderer; relative images resolve from the document's directory under the same file-access authorization. Plain text, common code and configuration files, CSV/TSV and subtitles show a bounded text preview with syntax highlighting when available. HTML, HTM and SVG remain isolated by both the frame sandbox and the Host's response policy. Images, video and audio use browser media elements, with a visible error when decoding fails. Every format offers Download original.

Text previews retain at most 256 KiB, cancel further reading at the limit and display a truncation notice. Failed reads show an error rather than loading the complete raw file in a frame. Office conversion reports an unavailable provider, invalid content, size limits, a busy queue or changed files/workspaces; missing original fonts produce a substitution notice. Listing failures retain previous data with a visible retry. A successful refresh reconciles the selection and reloads its preview, including a previously failed preview at the same path; obsolete responses are ignored.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin contributes the `artifacts` main panel and its sidebar entry through declaration-aware slot registrations. [`ArtifactsMain.tsx`](src/client/ArtifactsMain.tsx) derives refreshes from existing conversation activity and workspace sources; [`ArtifactsPage.tsx`](src/client/ArtifactsPage.tsx) owns search, filters, selection and management dialogs. [`ArtifactPreview.tsx`](src/client/ArtifactPreview.tsx) owns format-specific previews and original-file downloads. Injected callbacks own file management HTTP operations and optional native directory and file actions. Its injected dictionary supplies the page copy; the Host half is empty.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages describe the adjacent responsibilities and composition.

- [artifacts-index](../../deliverables/artifacts-index/README.md) — filesystem listing and reads.
- [ui-sidebar](../ui-sidebar/README.md) — navigation entries.
- [Web client](../../../docs/subsystems/web-client.md) — browser composition.

-----

<a id="model-experience"></a>
## Model Experience

### Browser presentation

#### What the model sees

Browsing `/artifacts/api/list` or a preview changes no model request and submits no file to a model.

#### Token effect

This package adds no text or files to model requests.

#### KV Cache effect

This package neither assembles provider requests nor changes model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the package’s current behavior and dependencies.

- Listings refresh on mount, user request, conversation activity or workspace changes, and return to a visible focused window. The page has no filesystem subscription or polling loop.
- Search covers the files returned within the Host's traversal limits; the folder dialog provides access beyond the initial recursive scan. Hidden, dependency and private artifact-state directories and symlink paths are excluded. Files deliberately saved outside all managed output roots and registered workspaces are outside this library's scope.
- The library shows current filesystem contents, not a complete history of generated outputs. Existing source files remain ordinary workspace files; neither a successful `present` call nor Git tracking is required for them to appear.
- Office previews require the serving Host's local conversion provider and show PDF pages, not an editable document or spreadsheet grid. Font substitution can change layout.
- PDF previews use the shared [document reader's limits](../ui-sidebar-documentpreview/README.md). Media playback depends on browser codec support. Archives, unknown binary formats and unsupported media codecs have no inline preview; download the original to open it with a compatible application.
- Search, filtering and selection belong to the mounted page and are not persisted. Directory preferences and recovery records belong to the Host.
- Renaming or recycling does not rewrite old chat links. Recovery retains file bytes and does not free their disk space. Unsupported filesystems cannot safely rename or recycle files.
- Paths and native file actions refer to the serving Host. A remote Host’s files are not files on the browser’s local machine; workspace filesystem mappings unsupported by that Host are refused.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
