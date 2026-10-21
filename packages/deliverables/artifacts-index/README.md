---
description: "Browse saved artifacts and registered workspace files with authenticated previews and reversible file management."
kind: "package-reference"
---

# @deepseek-ai/dsh-artifacts-index

English | [中文](README.zh.md)

## Summary

Browse saved artifacts and registered local workspace files together, inspect actual file paths, and rename, recycle or restore selected files. The library retains output-directory settings and includes existing workspace files as well as new outputs without attributing them all to generation. Browsing a workspace does not change where future media is saved.

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

Mount the plugin with the Host `webServer` service; managed storage and workspace access require authenticated `connection`. Workspace browsing also uses the live workspace registry. Pair it with [ui-artifacts](../../client/ui-artifacts/README.md) for the browser page. The minimal entry configures no output directories:

```yaml
- id: artifacts-index
  name: '@deepseek-ai/dsh-artifacts-index'
  config:
    roots: []
```

| Field | Default | Meaning |
|---|---|---|
| `defaultOutputDirectory` | `""` | Default media output directory, created on initialization. Set together with `stateDirectory` to enable managed storage. |
| `stateDirectory` | `""` | Separate private directory for output preferences and recovery records; never a browsing root. |
| `roots` | `[]` | Absolute directories to browse; relative entries are ignored and duplicates removed. |
| `maxEntries` | `2000` | Positive integer bounding a library response and each root's scan, or one workspace directory. |
| `maxDepth` | `5` | Positive integer bounding library traversal below each output or workspace root. |

`GET /artifacts/api/list` returns output roots, combined file metadata and a truncation flag. Workspace entries carry `workspaceId`; unavailable workspace sources appear in optional `issues` with their identity, title and a safe localized error code, without discarding other sources. `GET` and `HEAD /artifacts/api/raw?path=...` read a regular file under a canonical root, with single byte-range support; `download=1` returns an attachment with a safely encoded filename. Symlink paths and redirected retained roots are excluded. When Connection is mounted, all artifact reads and management requests use its authentication and Host/Origin checks. Managed storage or registered workspace listing without Connection refuses browser access; legacy roots-only configurations with no registered workspaces retain their read-only origin fence. HTML, HTM and SVG responses use a sandboxed content policy; known text suffixes receive text media types, while unrecognized binary formats remain octet-stream.

`GET` and `HEAD /artifacts/api/preview?path=...` convert DOC, DOCX, XLS, XLSX, PPT and PPTX to PDF through the optional [Office converter](../../document/office-to-pdf/README.md). Workspace sources add `workspaceId`, exactly as raw reads do. This endpoint always requires Connection authentication and never substitutes a Session for the selected workspace. It authorizes the canonical source before conversion, rechecks the live browsing scope and source version before and after its deferred bounded read, and checks them again before responding. Sources are never modified. The converter owns admission, byte limits, deadlines and cleanup; request disconnect and Host disposal cancel the reader. Successful responses are `application/pdf` with `no-store`, `nosniff` and an `x-artifact-preview-missing-fonts` count; font names and engine diagnostics are not exposed. Safe JSON failures use `preview-unavailable` or `preview-busy` (503), `preview-too-large` (413), `preview-invalid` (422), `preview-stale` (409), or `preview-failed` (500). Existing path and authorization failures retain their `ARTIFACT_…` codes.

The library recursively walks configured and retained output roots and currently registered canonical local workspaces. It removes duplicate canonical file paths before the response limit, preferring managed output coordinates. Each request resolves workspace access through the registry: unregistering it revokes browsing and file operations, and replacing its directory with a redirected path does not grant access elsewhere. Workspace browsing roots are not persisted as approved output roots. A nested file created with a shell command outside Git remains visible without a `present` event or recorded change summary; existing source files are ordinary workspace files, not proof of new generation.

`GET /artifacts/api/workspace?workspaceId=...&directory=...` lists a registered workspace directory. `directory` uses `/`-separated relative coordinates; an empty value names the root. The response identifies the workspace and absolute directory, supplies child directories and a parent coordinate for navigation, and includes files and a truncation flag. Workspace-file raw requests add `workspaceId` to the existing absolute `path`; rename and trash bodies add the same identity. The Host checks that identity and containment for each operation rather than trusting a previously returned listing.

`GET /artifacts/api/directory?root=...&directory=...` provides the same one-level browsing for an exact currently retained output root. It always requires Connection authentication and rechecks root membership and canonical location before and after the read. Its response includes `root`, the directory coordinates, child directories, files and `truncated`; managed entries have no `workspaceId`. The query cannot grant a new directory. Both directory routes allow the library to open deep files beyond its initial recursive scan.

Both directory routes accept an optional nonnegative integer `offset`, defaulting to zero, and return `nextOffset` when another page is available. Following that offset reaches entries beyond a directory's first `maxEntries` items. Each page reflects current filesystem contents and rechecks authorization rather than retaining an open directory or a filesystem snapshot.

`GET /artifacts/api/origin?path=...&size=...&mtimeMs=...` authenticates and version-checks the selected file, then returns its exact generating `sessionId`, `turn`, optional `eventSeq` and optional root `toolCallId`, or `null` when no identity record exists. Trusted `write` and `publish` producers supply optional `origin` metadata; private records bind it to device, inode, birth time, size and modification time before publishing bytes. Associations survive restart, rename, recycling and restore; replacing or editing the file invalidates them. Existing path-only generation records and unrelated workspace files have no inferred source.

New live `deliverables/presented` appends associate an otherwise unlinked file with its exact presentation card after checking the Session’s effective directory, local filesystem mapping and current output/workspace authorization. Seeded history never registers file paths. Existing generating associations remain authoritative when another chat presents the same bytes. Recording failures leave the presentation and file intact, report a warning and leave the source unavailable.

`GET /artifacts/api/storage` reads the current directory, default directory, revision and retained roots. `POST` to that path accepts `directory` and `expectedRevision`; the directory must already exist and be writable. Changing it affects future output only: existing files stay in place, previous roots remain listed, and in-flight producers retain their captured destination. Both storage configuration fields are required; roots-only configurations remain read-only.

`POST /artifacts/api/rename` accepts `path`, `name` and `expected: { size, mtimeMs }`. `POST /artifacts/api/trash` accepts the selected path and version; `GET` returns recoverable entries. `POST /artifacts/api/restore` accepts a recovery `id`. File management requires Connection authentication and its Host/Origin checks. Conflicts, changed files and unsupported safe moves fail without replacing existing files. Errors expose stable `ARTIFACT_…` codes. Deletion retains the bytes in a hidden same-volume recovery directory and a private persistent record; restore returns them to the original path and refuses to overwrite another file. No automatic purge or permanent-delete operation is provided.

Workspace files uses the same version-checked rename, trash and restore operations with live workspace authorization. Its recovery records retain the original canonical workspace root; restoration requires that exact directory to be registered again. Older library recovery records remain valid. The browser offers revealing a file in the serving Host's file manager when that Host provides the capability; paths and actions refer to that Host, including when the browser runs on another machine.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one `/artifacts` prefix through `ctx.webServer`. The library merges bounded recursive scans of retained output roots and registered workspaces; the compatibility workspace route lists one directory after checking its current registry membership. Both skip linked and unreadable entries. [`ArtifactStore`](src/storage.ts) owns persistent preferences, serialized file mutations and recovery records. Its trusted Host-only `artifactStorage` service captures a validated destination before paid work and exclusively writes bytes or copies a completed file there. These methods are not model tools and never change the conversation workspace. Raw previews use owned filesystem streams. See [`src/index.ts`](src/index.ts) and the [service contracts](src/types.ts).

Import shared browser metadata such as `ArtifactOrigin` through `@deepseek-ai/dsh-artifacts-index/types`; this types-only entry avoids bringing Host Cordis `Context` declarations into the client type graph. Host plugins and `artifactStorage` injection continue to use the main package entry.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages describe the adjacent responsibilities and composition.

- [ui-artifacts](../../client/ui-artifacts/README.md) — browser listing and preview.
- [host-webserver](../../host/webserver/README.md) — HTTP route registration.
- [Deliverables](../README.md) — adjacent deliverable responsibilities.

-----

<a id="model-experience"></a>
## Model Experience

### File browsing

#### What the model sees

The `/artifacts` routes return file metadata or bytes to a browser; they add no model input or Session events.

#### Token effect

This package adds no text or files to model requests.

#### KV Cache effect

This package neither assembles provider requests nor changes model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the package’s current behavior and dependencies.

- Output publication, renaming and recycling require filesystem support for exclusive same-volume hard links. Destination validation checks this before generation. Unsupported filesystems return a visible failure; no overwrite-capable fallback is attempted.
- Scans and the final response are bounded. Reaching a file, directory or depth limit sets `truncated`; a partial response is not a globally newest-files query. The browser searches the returned combined listing.
- Hidden and unreadable entries are omitted; workspace files also exclude dependency directories and private artifact state. Directory navigation excludes subdirectories whose names contain `:`, `\` or control characters unsupported by its portable navigation coordinates. Files can change between listing and reading.
- The index has no filesystem watcher. Renaming or recycling changes the filesystem path; earlier chat links are not rewritten. Recovery data remains on disk until restored or removed outside this page.
- Workspace files reflect current contents, not a complete generation history. They require a verified mapping to the serving Host filesystem; unsupported remote filesystem mappings fail visibly. Files outside the retained output roots and currently registered workspaces are not included. Paths and native actions belong to that Host, not the browser's computer.
- Converted previews require the optional Office provider and its local engine; unsupported formats and unavailable converters remain downloadable through the authorized raw route. Conversion does not provide byte-range responses.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
