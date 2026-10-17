---
description: "产物保存目录设置、可恢复文件管理与有界文件预览的宿主服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-artifacts-index

[English](README.md) | 中文

## 概述

浏览配置目录与保留的历史输出目录中的产物，更改后续媒体的保存位置，对选定文件重命名、移入回收区或恢复。索引按扩展名分类，按修改时间排序已收集条目；不推断文件由哪个 Session（会话）创建。

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

将插件与 Host 的 `webServer` 服务一起挂载；文件管理还需要经过认证的 `connection`。配合 [ui-artifacts](../../client/ui-artifacts/README.zh.md) 提供浏览器页面。最小配置项不列出任何目录：

```yaml
- id: artifacts-index
  name: '@deepseek-ai/dsh-artifacts-index'
  config:
    roots: []
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultOutputDirectory` | `""` | 默认媒体输出目录，初始化时创建；与 `stateDirectory` 一起设置以启用保存管理。 |
| `stateDirectory` | `""` | 单独的私有目录，用于输出偏好与恢复记录，不得作为浏览根目录。 |
| `roots` | `[]` | 要浏览的绝对目录；忽略相对路径并移除重复项。 |
| `maxEntries` | `2000` | 限制收集文件总数的正整数。 |
| `maxDepth` | `5` | 限制每个根目录下目录遍历深度的正整数。 |

`GET /artifacts/api/list` 返回根目录、文件元数据与截断标记。`GET` 和 `HEAD /artifacts/api/raw?path=...` 预览规范根目录内的普通文件，支持单段字节范围。符号链接路径与被重定向的历史根目录会被排除。挂载 Connection 时，全部产物读取与管理请求都通过其认证及 Host/Origin 校验。启用保存管理却没有 Connection 时拒绝浏览器访问；未挂载 Connection 的旧 roots 只读配置保留原有来源校验。HTML 和 SVG 响应采用沙箱内容策略。

`GET /artifacts/api/storage` 读取当前目录、默认目录、修订号与保留的根目录。向同一路径 `POST` 发送 `directory` 和 `expectedRevision`；目录必须已存在且可写。更改只影响后续输出：已有文件保留原位，旧根目录继续列出，在途生成使用其已捕获的目标。两项保存配置必须同时设置；只配置 roots 时仍为只读。

`POST /artifacts/api/rename` 接受 `path`、`name` 和 `expected: { size, mtimeMs }`。`POST /artifacts/api/trash` 接受选定路径与文件版本；`GET` 返回可恢复条目。`POST /artifacts/api/restore` 接受恢复记录 `id`。文件管理必须通过 Connection 认证及其 Host/Origin 校验。重名、文件已变化或不支持安全移动时明确失败，不替换已有文件。错误返回稳定的 `ARTIFACT_…` 代码。删除将文件字节保留在同卷隐藏恢复目录，并保存私有持久记录；恢复返回原路径，拒绝覆盖其他文件。不自动清理，也不提供永久删除操作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件通过 `ctx.webServer` 注册一个 `/artifacts` 前缀。有界列表以广度优先遍历当前与保留的规范根目录，跳过隐藏、链接及不可读条目。[`ArtifactStore`](src/storage.ts) 负责持久偏好、串行文件修改与恢复记录。仅供可信 Host 使用的 `artifactStorage` 服务在计费前捕获经过校验的目标，随后以独占方式写入字节或复制成片。这些方法不是模型工具，也不会改变会话工作区。原始预览使用具有生命周期归属的文件系统流。参见 [`src/index.ts`](src/index.ts) 与[服务契约](src/types.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

这些文档介绍相邻职责与组合方式。

- [ui-artifacts](../../client/ui-artifacts/README.zh.md)——浏览器列表与预览。
- [host-webserver](../../host/webserver/README.zh.md)——HTTP 路由注册。
- [交付物](../README.zh.md)——相邻交付职责。

-----

<a id="model-experience"></a>
## 模型体验

### 文件浏览

#### 模型看到什么

`/artifacts` 路由向浏览器返回文件元数据或字节，不添加模型输入或 Session 事件。

#### Token 影响

本包不向模型请求添加文本或文件。

#### KV Cache 影响

本包不组装提供商请求，也不修改模型上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本包当前的行为与依赖。

- 输出发布、重命名与回收要求文件系统支持同卷独占硬链接，目标校验会在生成前检查此能力。不支持的文件系统明确失败，不回退到可能覆盖文件的操作。
- 列表在排序前执行数量限制，因此截断响应不是全局最新文件查询。
- 隐藏和不可读条目会被省略；文件可能在列出与读取之间发生变更。
- 索引没有文件系统监听或 Session 归属记录。重命名或回收会改变文件路径，不改写之前的聊天链接。恢复数据保留在磁盘上，直到恢复或在页面外主动清理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
