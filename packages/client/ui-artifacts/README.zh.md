---
description: "产物页面，提供保存目录设置、搜索、预览、重命名和可恢复删除。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-artifacts

[English](README.md) | 中文

## 概述

在同一产物页面管理文件：查看或更改保存目录、搜索名称与路径、按类型筛选、预览、重命名、回收与恢复。页面使用宿主的文件系统索引，不推断文件由哪个 Session（会话）创建。

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

页面读取 `/artifacts/api/list`、`/artifacts/api/storage` 和 `/artifacts/api/trash`。目录弹窗接受已存在的绝对路径，原生文件夹选择器可用时提供选择按钮。保存目录只影响后续生成，已有文件继续可见，不自动移动。搜索同时匹配名称和路径，并与当前类型筛选叠加。

选中文件后可预览、重命名或移入回收区。文件操作携带选定版本的大小与修改时间；文件变化或重名时要求重新检查，不覆盖其他文件。回收区支持恢复，包括重新打开应用之后。删除需要确认；修改结果未知时，需要先刷新再继续操作。

图片、视频和音频使用浏览器媒体元素；支持的文本、代码和表格类型使用文本预览。嵌入的原始预览受沙箱隔离。读取失败保留之前数据，并显示重试入口。刷新会将选中文件与当前列表重新匹配，忽略已过时响应。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

浏览器插件通过等待 slot 声明的注册方式贡献 `artifacts` 主面板与侧栏入口。[`ArtifactsPage.tsx`](src/client/ArtifactsPage.tsx) 负责临时搜索、筛选、选择与管理弹窗。注入回调负责 HTTP 操作及可选的原生目录选择。注入的字典提供页面文案；Host 侧为空。

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
- 搜索、筛选与选择属于当前挂载的页面，不会持久化；目录偏好与恢复记录由 Host 保存。
- 重命名或回收不会改写旧聊天链接。回收保留文件字节，不会释放其磁盘空间。不支持安全操作的文件系统无法重命名或回收。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
