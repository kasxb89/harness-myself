---
description: "Artifacts page for output-directory settings, search, previews, renaming and recoverable deletion."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-artifacts

English | [中文](README.zh.md)

## Summary

Manage files in one Artifacts page: view or change the save directory, search names and paths, filter by kind, preview, rename, recycle and restore. The page uses the host’s filesystem index; it does not infer which Session created a file.

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

Mount `@deepseek-ai/dsh-client-ui-artifacts` in the browser roster with the slot and locale services. Pair it with [artifacts-index](../../deliverables/artifacts-index/README.md), whose roots determine the files shown. This package has no configuration fields.

The page reads `/artifacts/api/list`, `/artifacts/api/storage` and `/artifacts/api/trash`. The directory dialog accepts an existing absolute path and offers the native folder picker when available. Saving a directory affects future generation, keeps older files visible, and does not move them. Search matches names and paths together with the current type filter.

Select a file to preview, rename or move it to the recovery area. File changes use the selected size and modification time; a changed or conflicting file requires review instead of overwriting. Restore entries from the recovery area, including after reopening the app. Destructive actions require confirmation; uncertain mutation outcomes require refreshing before trying again.

Images, video and audio use browser media elements; supported text, code and spreadsheet kinds use a text preview. Embedded raw previews are sandboxed. Read failures retain previous data with a visible retry. Refresh reconciles the selected file with the current listing and ignores obsolete responses.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin contributes the `artifacts` main panel and its sidebar entry through declaration-aware slot registrations. [`ArtifactsPage.tsx`](src/client/ArtifactsPage.tsx) owns transient search, filters, selection and management dialogs. Injected callbacks own HTTP operations and optional native directory selection. Its injected dictionary supplies the page copy; the Host half is empty.

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

- Listings refresh on mount or user request; the page has no filesystem subscription.
- Document, slide, archive and other unsupported kinds show file information rather than a converted preview.
- Text previews above 256 KiB, or failed text reads, fall back to the raw URL in a frame; format rendering depends on the browser.
- Search, filtering and selection belong to the mounted page and are not persisted. Directory preferences and recovery records belong to the Host.
- Renaming or recycling does not rewrite old chat links. Recovery retains file bytes and does not free their disk space. Unsupported filesystems cannot safely rename or recycle files.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
