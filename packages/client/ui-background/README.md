---
description: "CSS backdrop presets for the Web shell, with configurable strength, grain and sidebar translucency."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-background

English | [中文](README.zh.md)

## Summary

Choose an aurora, obsidian or pearl backdrop behind the application frame. Configure its strength, film grain and sidebar translucency, or select `off` to retain the theme’s normal fills. The animated layer respects reduced-motion preferences; menus and dialogs retain their theme fills.

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

Mount this plugin as a browser-enabled profile entry:

```yaml
- id: ui-background
  name: '@deepseek-ai/dsh-client-ui-background'
  config:
    preset: aurora
    intensity: 0.72
    grain: true
    glassSidebar: true
```

| Field | Default | Meaning |
|---|---|---|
| `preset` | `aurora` | `aurora`, `obsidian`, `pearl`, or `off`. |
| `intensity` | `0.72` | Background strength from 0 through 1. |
| `grain` | `true` | Enable the film-grain layer. |
| `glassSidebar` | `true` | Use the theme-aware translucent sidebar fill. |

Grain is independent of the preset. Disable it explicitly with `grain: false` when selecting `off` to remove that layer too.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser half inserts a stylesheet and marks the root element with the selected preset. It overrides `--dsw-alias-bg-base` and, when requested, `--dsw-specific-sidebar-fill` only on the application frames under `#root`. A mutation observer tracks replaced frames; disposal restores each frame’s previous inline values and removes the stylesheet and root markers. The Host half contributes no behavior. See [`src/client/index.ts`](src/client/index.ts) and [`backdrop.css`](src/client/backdrop.css).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages describe the adjacent responsibilities and composition.

- [ui-theme](../ui-theme/README.md) — theme fills and color tokens.
- [ui-sidebar](../ui-sidebar/README.md) — sidebar presentation.
- [Web styling](../../../docs/web-styling.md) — shared styling rules.

-----

<a id="model-experience"></a>
## Model Experience

### Browser presentation

#### What the model sees

The `ui-background` entry changes browser styles only and registers no model-facing content.

#### Token effect

This package adds no text or files to model requests.

#### KV Cache effect

This package neither assembles provider requests nor changes model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the package’s current behavior and dependencies.

- The backdrop uses CSS gradients, blur and keyframes; it does not load Workspace or brand media.
- Only the frame base and optional sidebar fill become translucent; conversation panels retain their theme fills.
- Custom styles can override the backdrop selectors or the same inline properties.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
