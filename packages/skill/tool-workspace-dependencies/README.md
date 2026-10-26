---
description: "The load_workspace_dependencies tool: absolute paths into a bundled Python, Node.js, and pnpm payload, used in place or installed under the Harness home."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workspace-dependencies

English | [中文](README.zh.md)

## Summary

Deployments that ship their own script runtimes (Desktop's primary runtime, or a container image layer) mount this tool so the agent can ask where the bundled Python, Node.js, and pnpm live instead of discovering a system interpreter. The tool returns absolute paths and recorded distribution versions; it changes neither `PATH` nor package-manager settings. The payload is either copied under the Harness home on first use (Desktop) or used where it lies (read-only carriers).

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

Mount the plugin beside the tool registry with the payload directory. Configuration validation requires a nonempty `source` and rejects empty `root` values before activation; both paths must be absolute. The bundled Office skills (`@deepseek-ai/dsh-skill-office`) reference this tool by name for their default interpreter.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-tool-workspace-dependencies'
  config:
    source: /path/to/primary-runtime
```

| Field | Default | Meaning |
|---|---|---|
| `source` | required | Absolute payload directory carrying `runtime.json` and `dependencies/`. |
| `root` | unset | Absolute installation directory under the Harness home. Set: install a stable dependency generation beneath the sibling `<root>.payloads/`; matching locked dependencies are reused across carrier versions. Legacy manifests without a digest retain the fixed directory. Unset: validate and use the payload in place. |
| `lockWaitMs` | `30000` | Maximum wait for another installer; never expires its ownership. |
| `lockPollMs` | `100` | Poll interval while another installer owns preparation. |

Digest-bearing generation identity includes the platform, architecture, payload digest, interpreter/package-manager versions, and sorted official Python distribution versions. `desktopVersion` records the carrier and does not invalidate matching dependencies. Every first preparation validates the carrier and installed executable/library entries. Missing or malformed local entries are repaired through an atomic staged publication. This is entry validation, not a complete installed-file hash audit. Old generations and previous trees remain available to running applications; automatic cleanup is not performed. A private, atomically published PID-owned lock serializes independent Hosts; only a confirmed dead process can be recovered, and a live stalled owner is never displaced by elapsed time. If the recovery process itself dies before retiring the lock, preparation reports the interrupted recovery for inspection instead of deleting an unverified live lock.

### Payload layout

`runtime.json` records `desktopVersion`, `platform` (`win32`, `darwin`, or `linux`), `arch`, optional `payloadDigest`, top-level `python`, optional `node`/`pnpm` versions, and the complete `pythonPackages` distribution-version map. A pnpm entry requires Node.js. Python libraries, including numpy and pandas, appear only in `pythonPackages`. Entries live under `dependencies/`: `python/bin/python3` (`python/python.exe` on Windows) with `site-packages` beneath it, and, when declared, `node/bin/node` with `node/node_modules` and `pnpm/bin/pnpm.mjs`. A manifest whose platform or architecture differs from the running process is rejected.

The packaged `sdk` profile uses its bundled Python and Office skills by default; `DSH_PRIMARY_RUNTIME` overrides the resource location, and an empty value opts out. Source launches without a carrier default remain opt-in. See [runtime configuration](../../../python/sdk-runtime/README.md) for independent skill selection. Missing skill resources produce a startup warning; invalid or incomplete external runtime payloads fail the first tool call. Profile configuration changes require restarting the SDK process.

### Build a carrier payload

From a repository checkout with dependencies installed, `CI=true pnpm run prepare:primary-runtime --target linux-x64 --output /tmp/dsh-office` writes `primary-runtime/` and `office-skills/`. The shared [download lock](../../../scripts/primary-runtime/lock.json) also covers `linux-arm64`, `mac-arm64`, `mac-x64`, and `win-x64`. `--python-only` omits Node.js and pnpm; `--cache` selects the hash-verified archive cache. The entry executes interpreter and Office read/write checks only for a native target. Cross-target builds require those checks on the target host before deployment.

A container can copy both directories into an immutable image layer and set `DSH_PRIMARY_RUNTIME` to the absolute `primary-runtime/` path. The SDK queries that payload in place. Desktop uses the same builder and retains its Harness-home installation and signing checks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`readPrimaryRuntime` and build smoke checks share `parsePrimaryRuntime`. It validates the flat manifest and rejects duplicate normalized distribution names. Legacy `components` metadata is normalized in memory, retaining its consistency checks; a missing legacy distribution map becomes empty. Mixed flat and legacy version fields are rejected. Reads do not rewrite metadata, and equivalent normalized manifests can reuse an installed payload. `workspaceDependencyPaths` derives the platform-specific entries. `installPrimaryRuntime` copies into a staging directory, requires declared interpreters and scripts to be files and package roots to be directories, and publishes it atomically while retaining previous trees; `resolvePrimaryRuntime` verifies the same entries without copying. The tool memoizes the first successful preparation for the plugin's lifetime.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Manifest validation, path derivation, in-place and installed preparation, tool registration. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Office skills](../skill-office/README.md) — the workflows that call this tool for their interpreter.
- [Tool registry](../../core/tools/README.md) — registration and schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`load_workspace_dependencies` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-workspace-dependencies).

#### Token effect

Fixed schema cost per request where the tool is visible; the description names the bundled Office libraries so the model can choose the interpreter without loading a skill first.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged.

### Tool result

#### What the model sees

One JSON object with absolute `python` and `pythonPackages` paths, `pythonDistributions` from `runtime.json`, and `node`, `nodePackages`, and `pnpm` when the payload declares them. Repeated calls return the same object.

#### Token effect

A few hundred characters per call; paths dominate.

#### KV Cache effect

Append-only tool result in the turn history; no prompt section is added.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- If a recovery process dies before retiring a dead installer’s lock, the tool stops with an interrupted-recovery diagnostic and preserves the lock for inspection. This rare recovery interruption is not automatically repaired; it is a local tool failure and does not terminate the client.
- Linux targets require glibc; musl payloads are not locked.
- Windows payloads used in place must already be executable from their carrier; the in-place mode performs no permission repair.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

</details>
