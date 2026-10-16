---
description: "Mobile sidebar footer entry and page for the IM bridge’s WeChat binding panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile

English | [中文](README.zh.md)

## Summary

Open the Mobile page from the sidebar footer to reach the IM bridge’s channel panel with WeChat selected. The bridge supplies binding, QR codes and connection status. If its panel is unavailable, the page displays a localized hint.

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

Mount `@deepseek-ai/dsh-client-ui-mobile` in the browser roster with slots, locale and layout services. Compose the IM bridge separately when channel binding is needed; this package reads its optional `dshImClient` service. This package has no configuration fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers the `mobile` main panel and a `sidebar.footer.action` control. The injected callback asks `dshImClient.render` for the bridge panel with `preferredSectionId: weixin`. [`MobilePage.tsx`](src/client/MobilePage.tsx) reads that callback when mounted and substitutes a hint if it returns no panel or throws. The Host half is empty.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages describe the adjacent responsibilities and composition.

- [ui-sidebar](../ui-sidebar/README.md) — footer navigation.
- [ui-layout](../ui-layout/README.md) — main-panel selection.
- [Web client](../../../docs/subsystems/web-client.md) — browser composition.

-----

<a id="model-experience"></a>
## Model Experience

### Browser presentation

#### What the model sees

The `mobile` panel adds no model input. Any channel messages and model interactions belong to the IM bridge.

#### Token effect

This package adds no text or files to model requests.

#### KV Cache effect

This package neither assembles provider requests nor changes model context.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe the package’s current behavior and dependencies.

- QR generation, account binding, channel transport and status recovery belong to the optional bridge.
- The mounted page does not subscribe to service availability; it reads the bridge panel when its mount effect runs.
- A missing service and a bridge rendering failure both display the unavailable-panel hint.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
