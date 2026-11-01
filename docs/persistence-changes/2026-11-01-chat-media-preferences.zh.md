---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-chat-media-preferences

[English](2026-11-01-chat-media-preferences.md) | 中文

## 概述

新增必需的 media/request-selection 事件，为每次受理的真人 RPC 捕获一次个人媒体默认，后续偏好变化不能替换它。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-chat-media-preferences
baseline: false
changes:
  - root: "event:media/request-selection"
    previous: null
    after: "398f876feef88e9156a9fb896dacf0c9fa6e6ed6fefa43ad532377b10440dd96"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有 Session 事件和格式 4 文件保持不变且仍可读取。缺少新事件时保留原有媒体解析。新事件仅含请求标识、静态型号和参数、匿名偏好作用域及修订号，或有界的不可用标记；它不是模型生成的授权，不替代已受理任务恢复或非 H3 费用确认。该判别符是必需事件，不携带 ignorable:true。生产格式 4 事件词汇恢复器使用当前已知事件集合时接受该记录，使用旧版读取器的已知集合时拒绝同一记录，防止静默丢弃会影响生成和计费的选择。事件判别符可使旧版读取器安全拒绝，因此保留当前格式版本，不重写已提交代或历史记录。

<a id="verification"></a>
## 验证

三个聚焦 Host 测试套件 media-preferences.spec.ts、media-request-selection.spec.ts 和 media-preferences-routes.spec.ts 共 23 项通过，包含真实 Loader 和认证 HTTP 路由、先定价后型号的目录初始化、作用域与 CAS 隔离、每个 RPC 的必需快照、不透明的原生及 PTC 来源绑定、真人明确覆盖、合法分批及辅助图片数量。独立生产词汇恢复器使用当前词汇接受新记录，使用旧词汇拒绝该记录。已有受理及未知任务、充值重试和非 H3 报价检查另行执行。所有供应商均为本地替身，没有付费生成或服务器部署。升级指南说明受影响聊天须保留新版读取器。

<a id="dev-note"></a>
## 开发备注

无。
