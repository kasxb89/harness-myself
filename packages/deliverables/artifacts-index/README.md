---
description: "Host filesystem listing and raw-file routes for the Artifacts page, configured by root directories and traversal limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-artifacts-index

English | [中文](README.zh.md)

## Summary

List files under selected directories and read them for browser preview. The index groups files by extension and returns collected entries in descending modification-time order. Empty roots expose an empty listing; the package does not create artifacts or track their Session of origin.

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

Mount the plugin with the Host `webServer` service; pair it with [ui-artifacts](../../client/ui-artifacts/README.md) for the browser page. The minimal entry lists no directories:

```yaml
- id: artifacts-index
  name: '@deepseek-ai/dsh-artifacts-index'
  config:
    roots: []
```

| Field | Default | Meaning |
|---|---|---|
| `roots` | `[]` | Absolute directories to browse; relative entries are ignored and duplicates removed. |
| `maxEntries` | `2000` | Positive integer bounding the total files collected. |
| `maxDepth` | `5` | Positive integer bounding directory traversal below each root. |

`/artifacts/api/list` returns roots, file metadata and a truncation flag. `/artifacts/api/raw?path=...` reads an absolute path lexically contained in a configured root and supports a single byte range. Other methods or paths receive an error response. Origins outside loopback HTTP(S) and `dsh-app://app` are rejected; absent and `null` origins are accepted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one `/artifacts` prefix through `ctx.webServer`. Each listing walks the configured roots breadth-first, skips dot-prefixed entries and unreadable paths, stops at the configured limits, then sorts collected files. Raw reads use filesystem streams. The registration belongs to the plugin effect and is removed on disposal. See [`src/index.ts`](src/index.ts).

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

- Root checks normalize paths without resolving symlink targets. Configure trusted directories; these routes are not a filesystem sandbox.
- The listing is bounded before sorting, so a truncated response is not a globally newest-files query.
- Hidden and unreadable entries are omitted; files can change between listing and reading.
- The index has no filesystem watcher, write operation, Session attribution or user authentication.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
