---
description: "Host artifact storage preferences, reversible file management, and bounded filesystem previews."
kind: "package-reference"
---

# @deepseek-ai/dsh-artifacts-index

English | [中文](README.zh.md)

## Summary

Browse artifacts from configured and retained output directories, change the destination for future media, and rename, recycle or restore selected files. The index groups files by extension and sorts collected entries by modification time. It does not infer which Session created a file.

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

Mount the plugin with the Host `webServer` service; file management also requires authenticated `connection`. Pair it with [ui-artifacts](../../client/ui-artifacts/README.md) for the browser page. The minimal entry lists no directories:

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
| `maxEntries` | `2000` | Positive integer bounding the total files collected. |
| `maxDepth` | `5` | Positive integer bounding directory traversal below each root. |

`GET /artifacts/api/list` returns roots, file metadata and a truncation flag. `GET` and `HEAD /artifacts/api/raw?path=...` preview a regular file under a canonical root, with single byte-range support. Symlink paths and redirected retained roots are excluded. When Connection is mounted, all artifact reads and management requests use its authentication and Host/Origin checks. Managed storage without Connection refuses browser access; legacy roots-only configurations without it retain their read-only origin fence. HTML and SVG responses use a sandboxed content policy.

`GET /artifacts/api/storage` reads the current directory, default directory, revision and retained roots. `POST` to that path accepts `directory` and `expectedRevision`; the directory must already exist and be writable. Changing it affects future output only: existing files stay in place, previous roots remain listed, and in-flight producers retain their captured destination. Both storage configuration fields are required; roots-only configurations remain read-only.

`POST /artifacts/api/rename` accepts `path`, `name` and `expected: { size, mtimeMs }`. `POST /artifacts/api/trash` accepts the selected path and version; `GET` returns recoverable entries. `POST /artifacts/api/restore` accepts a recovery `id`. File management requires Connection authentication and its Host/Origin checks. Conflicts, changed files and unsupported safe moves fail without replacing existing files. Errors expose stable `ARTIFACT_…` codes. Deletion retains the bytes in a hidden same-volume recovery directory and a private persistent record; restore returns them to the original path and refuses to overwrite another file. No automatic purge or permanent-delete operation is provided.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one `/artifacts` prefix through `ctx.webServer`. Each bounded listing walks current and retained canonical roots breadth-first and skips hidden, linked and unreadable entries. [`ArtifactStore`](src/storage.ts) owns persistent preferences, serialized file mutations and recovery records. Its trusted Host-only `artifactStorage` service captures a validated destination before paid work and exclusively writes bytes or copies a completed file there. These methods are not model tools and never change the conversation workspace. Raw previews use owned filesystem streams. See [`src/index.ts`](src/index.ts) and the [service contracts](src/types.ts).

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

- Renaming and recycling require filesystem support for exclusive same-volume hard links. Unsupported filesystems return a visible failure; no overwrite-capable fallback is attempted.
- The listing is bounded before sorting, so a truncated response is not a globally newest-files query.
- Hidden and unreadable entries are omitted; files can change between listing and reading.
- The index has no filesystem watcher or Session attribution. Renaming or recycling changes the filesystem path; earlier chat links are not rewritten. Recovery data remains on disk until restored or removed outside this page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
