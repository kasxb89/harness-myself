---
description: "广场侧栏入口与页面，用于承载 profile 的插件市场面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-plaza

[English](README.md) | 中文

## 概述

打开广场页面，在应用主栏中使用插件市场。市场提供方供应自己的控件与内容。提供方可用之前，页面显示本地化的市场不可用提示。

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

将 `@deepseek-ai/dsh-client-ui-plaza` 与 slot 和语言服务一起挂载在浏览器插件列表中。另行组合市场提供方，由其供应可选的 `market` 服务。本包没有配置字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

浏览器插件注册 `plaza` 主面板与侧栏入口。Cordis 注入将市场的渲染函数交给 [`PlazaPage.tsx`](src/client/PlazaPage.tsx)；后者通过外部存储订阅，在该函数到达时更新已挂载的页面。提供方负责渲染出的市场树；Host 侧为空。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些文档介绍相邻职责与组合方式。

- [ui-sidebar](../ui-sidebar/README.zh.md)——导航入口。
- [ui-layout](../ui-layout/README.zh.md)——主面板选择。
- [Web 客户端](../../../docs/subsystems/web-client.zh.md)——浏览器组合方式。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器呈现

#### 模型看到什么

`plaza` 面板不贡献提示词、工具或模型消息。已安装插件负责各自面向模型的行为。

#### Token 影响

本包不向模型请求添加文本或文件。

#### KV Cache 影响

本包不组装提供商请求，也不修改模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包当前的行为与依赖。

- 目录查询、安装、移除与授权由市场提供方负责。
- 页面保留最后供应的市场控制对象；移除提供方不会清空该对象。
- 市场渲染失败不会转换为市场不可用提示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
