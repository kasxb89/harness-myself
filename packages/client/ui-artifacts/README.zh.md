---
description: "产物侧栏页面，用于按类型筛选已配置目录中的文件，并预览支持的媒体或文本。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-artifacts

[English](README.md) | 中文

## 概述

在产物页面浏览配置目录中的文件，按类型筛选，并选择支持的文件进行预览。文件变更后可刷新列表。页面使用宿主的文件系统索引，不推断文件由哪个 Session（会话）创建。

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

将 `@deepseek-ai/dsh-client-ui-artifacts` 与 slot 和语言服务一起挂载在浏览器插件列表中。配合 [artifacts-index](../../deliverables/artifacts-index/README.zh.md) 使用，由后者的 roots 决定显示哪些文件。本包没有配置字段。

页面在挂载和点击刷新时读取 `/artifacts/api/list`。图片、视频和音频使用浏览器媒体元素；文本、代码和表格类型在支持时使用文本预览。列表读取失败会显示错误，并保留刷新操作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

浏览器插件通过等待 slot 声明的注册方式贡献 `artifacts` 主面板与侧栏入口。[`ArtifactsPage.tsx`](src/client/ArtifactsPage.tsx) 负责临时筛选、选择和 HTTP 读取。注入的字典提供页面文案；Host 侧为空。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些文档介绍相邻职责与组合方式。

- [artifacts-index](../../deliverables/artifacts-index/README.zh.md)——文件系统列表与读取。
- [ui-sidebar](../ui-sidebar/README.zh.md)——导航入口。
- [Web 客户端](../../../docs/subsystems/web-client.zh.md)——浏览器组合方式。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器呈现

#### 模型看到什么

浏览 `/artifacts/api/list` 或预览不会改变模型请求，也不会向模型提交文件。

#### Token 影响

本包不向模型请求添加文本或文件。

#### KV Cache 影响

本包不组装提供商请求，也不修改模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包当前的行为与依赖。

- 列表在挂载或用户请求时刷新；页面不订阅文件系统变更。
- 文档、幻灯片、压缩包和其他不支持的类型显示文件信息，不提供转换后的预览。
- 超过 256 KiB 的文本预览或失败的文本读取会回退为框架内的原始 URL；格式呈现取决于浏览器。
- 筛选与选择属于当前挂载的页面，不会持久化。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
