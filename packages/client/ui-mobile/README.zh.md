---
description: "手机端侧栏底部入口与页面，用于展示 IM 桥接插件的微信绑定面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile

[English](README.md) | 中文

## 概述

从侧栏底部打开手机端页面，进入默认选择微信的 IM 桥接通道面板。绑定、二维码和连接状态由桥接插件提供。面板不可用时，页面显示本地化提示。

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

将 `@deepseek-ai/dsh-client-ui-mobile` 与 slot、语言和布局服务一起挂载在浏览器插件列表中。需要通道绑定时另行组合 IM 桥接插件；本包读取其可选的 `dshImClient` 服务。本包没有配置字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

浏览器插件注册 `mobile` 主面板与 `sidebar.footer.action` 控件。注入的回调通过 `dshImClient.render` 请求桥接面板，传入 `preferredSectionId: weixin`。[`MobilePage.tsx`](src/client/MobilePage.tsx) 在挂载时读取该回调；未返回面板或抛错时显示提示。Host 侧为空。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些文档介绍相邻职责与组合方式。

- [ui-sidebar](../ui-sidebar/README.zh.md)——底部导航。
- [ui-layout](../ui-layout/README.zh.md)——主面板选择。
- [Web 客户端](../../../docs/subsystems/web-client.zh.md)——浏览器组合方式。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器呈现

#### 模型看到什么

`mobile` 面板不添加模型输入。通道消息与模型交互由 IM 桥接插件负责。

#### Token 影响

本包不向模型请求添加文本或文件。

#### KV Cache 影响

本包不组装提供商请求，也不修改模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包当前的行为与依赖。

- 二维码生成、账号绑定、通道传输与状态恢复由可选的桥接插件负责。
- 已挂载的页面不订阅服务可用性；它在挂载 effect 执行时读取桥接面板。
- 服务缺失与桥接渲染失败都会显示面板不可用提示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
