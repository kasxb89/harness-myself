---
description: "Search the SkillHub community and install skills into the product from its sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skillhub

English | [中文](README.zh.md)

## Summary

Find community skills in the sidebar Skill store, install an explicitly selected skill, and inspect installed skills. Search and installation use the official SkillHub CLI in product-private storage. Installed skills become available to existing conversations without restarting. This store does not change another application's skills or installation-source preferences.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Web product bundle mounts this package. Open **Skill store**, enter a skill name or task, submit Search, and select Install on the desired result. The Installed tab lists successful product-managed installations. Installation never starts from navigation or search alone and refuses an existing destination.

The first operation requiring the CLI downloads the official version 2026.8.5 kit and verifies its pinned SHA-256 and the four selected files. The cache lives beneath the active Harness cache's `skillhub` directory. Desktop resolves and supplies its verified bundled Python executable, so Windows needs neither system Python nor Bash. A standalone Web deployment without that runtime uses the configured `pythonExecutable`.

| Field | Default | Meaning |
|---|---|---|
| `skillsDirectory` | Required | Absolute product user skills directory |
| `cacheDirectory` | Required | Absolute product-private CLI cache and state directory |
| `pythonExecutable` | `python3` | Verified bundled Python on Desktop; configured interpreter on Web |
| `timeoutMs` | `120000` | Complete operation deadline in milliseconds |
| `searchLimit` | `20` | Maximum community search results |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-client-ui-skillhub) lists all execution limits. The [official installation guide](https://skillhub.cn/install/skillhub.md) describes SkillHub's standalone CLI; this integration supplies product-owned staging instead of the CLI's default relative directory, then commits verified files to the product's skills directory.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser registers a keyed main panel and a sidebar entry between Plaza and Plugins. Authenticated local Connection routes own searches, installations and inventory reads. The Host executes the unmodified official CLI through the subprocess service with isolated configuration and disabled self-upgrade. A small Python adapter makes failed community searches explicit. No upstream account or product relay credential is passed to SkillHub.

Installation uses private staging before publishing a complete skill. Canonical community names, including namespaces, remain in the official lockfile; deterministic single-level directories beneath the active Harness home's `skills` directory let the existing filesystem provider discover them. Successful commits invalidate the Host catalog and the browser's skill-reference cache. Removing the plugin cancels and joins active operations and removes its routes, panel and dictionaries.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Filesystem skills](../../skill/skill-filesystem/README.md) — discovery and invalidation.
- [Skill references](../ui-skill/README.md) — conversation skill selection.
- [Sidebar](../ui-sidebar/README.md) — product navigation.
- [Bundled dependencies](../../skill/tool-workspace-dependencies/README.md) — verified Python runtime.

<a id="model-experience"></a>
## Model Experience

### Skill availability

#### What the model sees

The store contributes no tools or conversation messages. Installed `SKILL.md` files enter the existing filesystem catalog, and their own metadata and invocation rules determine when the model sees their content.

#### Token effect

Navigation, searches and installation add no model requests. Subsequent skill use follows the existing skill catalog and body-loading rules.

#### KV Cache effect

The store does not assemble provider requests. A changed skill catalog can alter later model context through the existing skill system.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This page manages community skills installed through the product.

- Enterprise login, paid purchases, skill upgrades and removal are not exposed.
- Web deployments without a bundled runtime need a usable configured Python executable.
- A lockfile write failure after a skill is published reports failure and retains the published files for inspection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
