---
description: "Web 外壳的沉浸式背景插件：极光、曜石、珍珠三套预设，跟随明暗主题并尊重减弱动效。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-background

## 概述

本包只贡献浏览器呈现：它把一个固定的背景层画在 Web 外壳的应用框架之后，让侧栏、卡片与对话面板像浮在极光之上。宿主半侧是空 `apply`，存在的意义是给 Loader 一个可启停的行。

背景不与主题包争夺所有权。它只在自己激活期间，把 `--dsw-alias-bg-base` 与 `--dsw-specific-sidebar-fill` 重新绑定在**应用框架元素**（`#root` 的第一个子元素）的内联样式上，因此 `document.body` 上的浮层、菜单与启动页仍使用主题原值。停用或卸载时这些内联值会被移除，界面回到官方外观。

## 使用本包

把本插件作为一个行加入 profile：

```yaml
- id: ui-background
  name: '@deepseek-ai/dsh-client-ui-background'
  config:
    preset: aurora
    intensity: 0.72
    grain: true
```

`preset` 取 `aurora`（默认）、`obsidian`、`pearl` 或 `off`。`intensity` 是 0–1 的强度，`grain` 控制胶片颗粒层。配置为可选项，缺省时使用上述默认值。

## 已知限制与延期工作

- 背景层是纯 CSS（渐变、模糊、关键帧），不读取工作区或品牌资源；换成位图或视频背景需要新增资源服务，本包不承担。
- 面板填充的半透明只通过侧栏令牌展宽；对话区仍使用主题原色，若要让整块面板玻璃化，应在 `ui-theme` 增加语义令牌，而不是在本包继续覆盖。
- 与用户自带的自定义样式表可能互相覆盖：本包的选择器都挂在 `html[data-dsh-backdrop]` 之下，卸载即失效。
