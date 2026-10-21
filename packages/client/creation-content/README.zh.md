---
description: "在图片与视频创作区读取已发布的模板、分类与提示词预设。"
kind: "package-reference"
---

# 创作内容发布

[English](README.md) | 中文

## 概述

本文是 `@deepseek-ai/dsh-client-creation-content` 的参考，说明图片与视频创作共用的发布内容读取器。本地管理服务负责页面文案、分类、模板、预览素材与提示词预设；本插件向两个工作区提供同一个无 React 依赖的 `ctx.creationContent` 可观察对象。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

发布内容请求按 `document.baseURI` 解析，保留 `/mount/` 等应用部署前缀；预览使用者也在同一前缀下解析原始素材路径。

读取器通过校验来源的 Host 转发接口访问 `/credits/api/creation/content`，仅提供已发布的模板与预设；停用的分类及其模板不对用户展示。上传的预览素材使用 `/credits/api/creation/assets/:id`，与账户自己的参考素材分开。发布内容为空时保持空态，不虚构示例内容。

`getSnapshot()` 在状态变化前保持对象身份稳定。`subscribe()` 返回取消订阅函数，`refresh()` 合并同时发生的读取。`loading`、`ready` 与 `error` 分别表示首次读取、可用内容及读取失败。失败时保留上次校验通过的文档，便于使用方提示内容可能过期并提供重试；成功读到新版本后整体替换文档。使用方通过渲染器的 `hooks` 分区注入可观察对象，组件不直接订阅。

经校验的 `refreshIntervalMs` 默认为 15,000 毫秒（范围 1,000–300,000）；`timeoutMs` 默认为 10,000 毫秒（范围 1,000–60,000）。可见的客户端定期刷新，并在获得焦点或恢复可见时刷新。卸载插件会移除监听与计时器、中止请求、关闭订阅并等待操作结束。读取发布内容不携带用户凭据。

<a id="model-experience"></a>
## 模型体验

### 已发布的创作描述

#### 模型看到什么

浏览器的 `ctx.creationContent` 读取不发送模型请求。选择管理员编写的模板或预设会修改用户可编辑的创作描述；后续用户明确触发的模型提交由创作工作区负责。

#### Token 影响

读取发布内容不增加模型 token。只有工作区提交所选描述时，描述才成为模型输入。

#### KV Cache 影响

读取器不管理模型对话或提供方缓存。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 更新需要本地管理服务可用；持续获得焦点的客户端最多需要一个刷新间隔才能看到变更。
- 从清单移除条目后，素材文件仍保持不可变；存储清理由管理服务负责。
- 文档支持中文与可选英文；使用方在缺少英文时回退中文。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
