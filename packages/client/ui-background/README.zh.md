---
description: "Web 外壳的 CSS 背景预设，可配置强度、颗粒和侧栏半透明效果。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-background

[English](README.md) | 中文

## 概述

在应用框架后方选择极光、曜石或珍珠背景。可配置强度、胶片颗粒和侧栏半透明效果，或选择 `off` 保留主题原有填充。动画层遵循减弱动效偏好；菜单与对话框保留各自的主题填充。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本插件作为支持浏览器侧的 profile 配置项挂载：

```yaml
- id: ui-background
  name: '@deepseek-ai/dsh-client-ui-background'
  config:
    preset: aurora
    intensity: 0.72
    grain: true
    glassSidebar: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `preset` | `aurora` | `aurora`、`obsidian`、`pearl` 或 `off`。 |
| `intensity` | `0.72` | 0 到 1 之间的背景强度。 |
| `grain` | `true` | 启用胶片颗粒层。 |
| `glassSidebar` | `true` | 使用跟随主题的半透明侧栏填充。 |

颗粒层独立于预设。选择 `off` 时，若也要移除颗粒层，需显式设置 `grain: false`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

浏览器侧插入样式表，并在根元素标记所选预设。它只在 `#root` 下的应用框架上覆盖 `--dsw-alias-bg-base`，并按配置覆盖 `--dsw-specific-sidebar-fill`。MutationObserver 跟踪被替换的框架；dispose（资源释放）会恢复每个框架先前的内联值，并移除样式表与根元素标记。Host 侧不提供行为。参见 [`src/client/index.ts`](src/client/index.ts) 与 [`backdrop.css`](src/client/backdrop.css)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些文档介绍相邻职责与组合方式。

- [ui-theme](../ui-theme/README.zh.md)——主题填充与颜色令牌。
- [ui-sidebar](../ui-sidebar/README.zh.md)——侧栏呈现。
- [Web 样式](../../../docs/web-styling.zh.md)——共享样式规则。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器呈现

#### 模型看到什么

`ui-background` 配置项只修改浏览器样式，不注册面向模型的内容。

#### Token 影响

本包不向模型请求添加文本或文件。

#### KV Cache 影响

本包不组装提供商请求，也不修改模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包当前的行为与依赖。

- 背景使用 CSS 渐变、模糊与关键帧，不加载 Workspace 或品牌媒体。
- 只有框架底色与可选的侧栏填充变为半透明；对话面板保留各自的主题填充。
- 自定义样式可以覆盖背景选择器或相同的内联属性。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
