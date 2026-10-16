---
description: "Plaza sidebar entry and page hosting the profile’s plugin-market panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plaza

English | [中文](README.zh.md)

## Summary

Open the Plaza page to use the plugin market inside the main application column. The market provider supplies its own controls and content. Until that provider is available, the page displays a localized unavailable-market hint.

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

Mount `@deepseek-ai/dsh-client-ui-plaza` in the browser roster with slots and locale services. Compose the market provider separately; it supplies the optional `market` service. This package has no configuration fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers the `plaza` main panel and sidebar entry. A Cordis injection passes the market’s render function to [`PlazaPage.tsx`](src/client/PlazaPage.tsx), whose external-store subscription updates the mounted page when that function arrives. The provider owns the rendered market tree; the Host half is empty.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages describe the adjacent responsibilities and composition.

- [ui-sidebar](../ui-sidebar/README.md) — navigation entries.
- [ui-layout](../ui-layout/README.md) — main-panel selection.
- [Web client](../../../docs/subsystems/web-client.md) — browser composition.

-----

<a id="model-experience"></a>
## Model Experience

### Browser presentation

#### What the model sees

The `plaza` panel contributes no prompts, tools or model messages. Installed plugins own their model-facing behavior.

#### Token effect

This package adds no text or files to model requests.

#### KV Cache effect

This package neither assembles provider requests nor changes model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the package’s current behavior and dependencies.

- Catalog queries, installation, removal and authorization belong to the market provider.
- The page retains the last supplied market control; provider removal does not clear that control.
- Market rendering failures are not converted into the unavailable-market hint.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
