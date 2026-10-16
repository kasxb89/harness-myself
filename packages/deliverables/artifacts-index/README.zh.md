---
description: "产物页面的宿主文件系统列表与原始文件路由，可配置根目录和遍历限制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-artifacts-index

[English](README.md) | 中文

## 概述

列出所选目录中的文件，并读取文件用于浏览器预览。索引按扩展名分类，将收集到的条目按修改时间降序返回。空 roots 提供空列表；本包不创建产物，也不追踪其来源 Session（会话）。

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

将插件与 Host 的 `webServer` 服务一起挂载；配合 [ui-artifacts](../../client/ui-artifacts/README.zh.md) 提供浏览器页面。最小配置项不列出任何目录：

```yaml
- id: artifacts-index
  name: '@deepseek-ai/dsh-artifacts-index'
  config:
    roots: []
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `roots` | `[]` | 要浏览的绝对目录；忽略相对路径并移除重复项。 |
| `maxEntries` | `2000` | 限制收集文件总数的正整数。 |
| `maxDepth` | `5` | 限制每个根目录下目录遍历深度的正整数。 |

`/artifacts/api/list` 返回根目录、文件元数据与截断标记。`/artifacts/api/raw?path=...` 读取在词法路径上包含于配置根目录的绝对路径，并支持单段字节范围。其他方法或路径返回错误响应。不属于回环 HTTP(S) 和 `dsh-app://app` 的 Origin 会被拒绝；缺少 Origin 和 `null` Origin 会被接受。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

插件通过 `ctx.webServer` 注册一个 `/artifacts` 前缀。每次列表请求以广度优先方式遍历配置根目录，跳过点前缀条目和不可读路径，达到配置限制后停止，再排序已收集文件。原始读取使用文件系统流。注册属于插件 effect，在 dispose（资源释放）时移除。参见 [`src/index.ts`](src/index.ts)。

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

- 根目录检查只规范化路径，不解析符号链接目标。请配置可信目录；这些路由不提供文件系统沙箱。
- 列表在排序前执行数量限制，因此截断响应不是全局最新文件查询。
- 隐藏和不可读条目会被省略；文件可能在列出与读取之间发生变更。
- 索引没有文件系统监听、写操作、Session 归属记录或用户认证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
