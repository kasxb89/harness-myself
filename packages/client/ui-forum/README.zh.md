---
description: "需求工作区中的论坛帖子、点赞与直接发布的评论。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-forum

[English](README.md) | 中文

<a id="summary"></a>
## 概述

在服务目录与私有需求旁增加论坛页签。帖子和评论直接发布，管理员随后在 harnes-api 审核或删除内容。本包共用产品登录，将论坛内容与私有需求消息、模型生成分开。

<a id="table-of-contents"></a>
## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

Web 组合通过 `demands.forum` 挂载论坛页签。现有额度 Host 在内部代理且仅代理 `/api/product/forum` 操作。浏览器取得公开作者名与账号保护标记，不取得上游凭证或私有客户档案。管理员在后台开启论坛写入；关闭写入后仍可阅读已有讨论。

`requestTimeoutMs` 设置完整请求期限，默认为 20 秒。`refreshMs` 设置可见论坛的刷新周期，默认为 15 秒。全部界面文案由中英文字典维护。

<a id="understand-the-implementation"></a>
## 理解实现

发布前先持久保存账号范围内的请求编号和固定正文。结果不明时保留草稿，用户手动重试同一提交。评论确认成功后直接显示原回执，再查询后续状态。点赞按用户与帖子唯一记录目标状态。管理员删除后服务端撤销读取权限，客户端在下次成功刷新后移除内容。论坛请求不复用私有需求或 AI 会话的附件。

<a id="further-exploration"></a>
## 进一步探索

- [额度 Host](../../host/credits-index/README.zh.md) 负责产品凭证和续期。
- [需求工作区](../ui-demands/README.zh.md) 负责论坛页签位置。

<a id="model-experience"></a>
## 模型体验

<a id="community-discussions"></a>
### 社区讨论

<a id="what-the-model-sees"></a>
#### 模型可见内容

`demands.forum` 插槽不新增提示词、工具、AI 会话或模型请求。

<a id="token-effect"></a>
#### Token 影响

论坛消息不进入生成计费或模型上下文。

<a id="kv-cache-effect"></a>
#### KV 缓存影响

论坛操作不改变上游缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 帖子和评论支持文字。附件上传、楼中楼和实时推送尚未实现；可见讨论按配置周期刷新。

<a id="dev-note"></a>
### 开发备注

论坛使用独立插件与接口域，使审核无法公开或删除私有需求会话。
