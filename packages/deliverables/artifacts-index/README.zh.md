---
description: "浏览已保存产物和已注册工作区文件，提供经过认证的预览与可恢复文件管理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-artifacts-index

[English](README.md) | 中文

## 概述

浏览已保存的产物或逐层打开已注册工作区的目录，查看文件实际路径，对选定文件重命名、移入回收区或恢复。产物库保留输出目录设置；工作区文件同时显示原有文件与新建文件，不把它们全部标为生成产物。浏览工作区不会改变后续媒体的保存位置。

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

将插件与 Host 的 `webServer` 服务一起挂载；保存管理和工作区访问需要经过认证的 `connection`。工作区浏览还使用实时工作区注册表。配合 [ui-artifacts](../../client/ui-artifacts/README.zh.md) 提供浏览器页面。最小配置项不列出任何目录：

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
| `maxEntries` | `2000` | 限制产物库单次列表或工作区单层目录条目数的正整数。 |
| `maxDepth` | `5` | 限制产物库在每个输出根目录下遍历深度的正整数。 |

`GET /artifacts/api/list` 返回根目录、文件元数据与截断标记。`GET` 和 `HEAD /artifacts/api/raw?path=...` 读取规范根目录内的普通文件，支持单段字节范围；`download=1` 返回附件，并安全编码文件名。符号链接路径与被重定向的历史根目录会被排除。挂载 Connection 时，全部产物读取与管理请求都通过其认证及 Host/Origin 校验。启用保存管理却没有 Connection 时拒绝浏览器访问；未挂载 Connection 的旧 roots 只读配置保留原有来源校验。HTML、HTM 和 SVG 响应采用沙箱内容策略；已知文本后缀使用文本媒体类型，未识别的二进制格式仍为 octet-stream。

`GET` 和 `HEAD /artifacts/api/preview?path=...` 通过可选的 [Office 转换器](../../document/office-to-pdf/README.zh.md) 将 DOC、DOCX、XLS、XLSX、PPT 和 PPTX 转为 PDF。工作区来源与原始读取相同，需要附带 `workspaceId`。该接口始终要求 Connection 认证，不用会话代替所选工作区。转换前先认证规范源文件；延迟且有界的读取前后，重新检查有效浏览范围与源文件版本；响应前再次检查。源文件不会被修改。转换器负责准入、字节限制、期限和清理；请求断开或 Host 释放会取消该读取者。成功响应为 `application/pdf`，带 `no-store`、`nosniff` 和 `x-artifact-preview-missing-fonts` 数量；不暴露字体名称或引擎诊断。安全的 JSON 失败码包括 `preview-unavailable` 或 `preview-busy`（503）、`preview-too-large`（413）、`preview-invalid`（422）、`preview-stale`（409）及 `preview-failed`（500）。已有路径与授权错误保留原有 `ARTIFACT_…` 代码。

产物库遍历配置目录与保留的历史输出根目录。工作区文件列出当前已注册的规范工作区根目录内的单层目录，并包含用于导航的目录条目。每次请求都通过注册表解析工作区：注销工作区会撤销浏览与文件操作权限，将该目录替换为重定向路径不会取得其他位置的访问权限。工作区浏览根目录不会作为获准输出根目录持久保存。在非 Git 目录内通过 shell 命令创建的文件，即使没有 `present` 事件或改动摘要，也能通过目录浏览找到；原有源文件属于普通工作区文件，不能证明它们是新生成的。

`GET /artifacts/api/workspace?workspaceId=...&directory=...` 列出已注册工作区的单层目录。`directory` 使用以 `/` 分隔的相对坐标，空值表示根目录。响应标明工作区与绝对目录，提供子目录和父目录坐标用于导航，并包含文件及截断标记。工作区文件的原始读取请求在现有绝对 `path` 之外添加 `workspaceId`；重命名和回收请求体也添加同一标识。Host 每次操作都校验此标识及目录包含关系，不信任此前返回的列表。

`GET /artifacts/api/storage` 读取当前目录、默认目录、修订号与保留的根目录。向同一路径 `POST` 发送 `directory` 和 `expectedRevision`；目录必须已存在且可写。更改只影响后续输出：已有文件保留原位，旧根目录继续列出，在途生成使用其已捕获的目标。两项保存配置必须同时设置；只配置 roots 时仍为只读。

`POST /artifacts/api/rename` 接受 `path`、`name` 和 `expected: { size, mtimeMs }`。`POST /artifacts/api/trash` 接受选定路径与文件版本；`GET` 返回可恢复条目。`POST /artifacts/api/restore` 接受恢复记录 `id`。文件管理必须通过 Connection 认证及其 Host/Origin 校验。重名、文件已变化或不支持安全移动时明确失败，不替换已有文件。错误返回稳定的 `ARTIFACT_…` 代码。删除将文件字节保留在同卷隐藏恢复目录，并保存私有持久记录；恢复返回原路径，拒绝覆盖其他文件。不自动清理，也不提供永久删除操作。

工作区文件复用带版本校验的重命名、回收与恢复操作，并实时检查工作区授权。其恢复记录保留原先的规范工作区根目录；恢复要求该目录重新注册。旧产物库恢复记录仍然有效。提供服务的 Host 支持相应能力时，浏览器提供在该 Host 文件管理器中显示文件的操作；即使浏览器运行在另一台电脑，路径和操作也属于该 Host。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件通过 `ctx.webServer` 注册一个 `/artifacts` 前缀。产物库以广度优先遍历保留的规范输出根目录；工作区范围在检查实时注册关系后列出单层目录。两者都跳过链接及不可读条目。[`ArtifactStore`](src/storage.ts) 负责持久偏好、串行文件修改与恢复记录。仅供可信 Host 使用的 `artifactStorage` 服务在计费前捕获经过校验的目标，随后以独占方式写入字节或复制成片。这些方法不是模型工具，也不会改变会话工作区。原始预览使用具有生命周期归属的文件系统流。参见 [`src/index.ts`](src/index.ts) 与[服务契约](src/types.ts)。

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
- 工作区逐层加载目录。浏览器只搜索当前目录，不搜索整个工作区或全部已注册工作区。
- 隐藏和不可读条目会被省略；工作区浏览还排除依赖目录、私有产物状态，以及名称含可移植导航坐标不支持的 `:`、`\` 或控制字符的子目录。文件可能在列出与读取之间发生变更。
- 索引没有文件系统监听或 Session 归属记录。重命名或回收会改变文件路径，不改写之前的聊天链接。恢复数据保留在磁盘上，直到恢复或在页面外主动清理。
- 工作区文件反映当前目录内容，不是完整的生成历史。它要求经过校验的服务 Host 文件系统映射；不支持的远端文件系统映射会明确失败。路径与原生操作属于该 Host，不属于浏览器所在电脑。
- 转换预览需要可选 Office 提供者及本地引擎；不支持的格式或不可用的转换器仍可通过经过授权的原始文件接口下载。转换结果不提供字节范围响应。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
