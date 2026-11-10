---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-text-reselection-proof

[English](2026-11-09-text-reselection-proof.md) | 中文

## 概述

为 Assistant 尝试／消息的结束失败、提供方重试记录及轮次结束错误添加可选的 LlmFailure.textReselection 元数据。Session 写入版本保持 V4。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-text-reselection-proof
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "84cc09319a505381b842d2bb8d03e12330b7cb4a1259ab099ba209f806812b3a"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "161d69bce499c9478b51057eb3a15051b6ad3642c39b205f641e5c68156a4b0c"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "a83bfd204ab3bc6058ec57b16c3586a02affdf69749cdb523f1b3f97d19ef852"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "a19a35e70b1e457fd82d10f3d92639f8052007dcb5c7b23933c0d8a79f57341d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧记录没有此字段，仍按原有失败含义读取；字段缺席不能证明没有提交上游或没有预留计费。本地持久化兼容性报告中标识的更改前 Session 读取器将新增子树作为普通 JSON 保留，并继续提供既有错误码和消息。它可以忽略该可选证据，保留原有的模型不可用处理。当前读取器保留两种记录形式及相同的模型可见消息。本次没有改变事件判别字段、必填字段、头部或生命周期含义。读取恢复的证明只是历史数据，不是新请求，也不是重放失败操作的指令。

<a id="verification"></a>
## 验证

使用 Node 22.23.2 执行 vitest run packages/session/session-format-catalog/tests/text-reselection.compat.spec.ts packages/core/session/tests/canonical-envelopes.spec.ts packages/session/session-format-catalog/tests/current.spec.ts，216 个测试全部通过。另以本地兼容性报告标识的精确旧读取器工作区及当前候选分别执行同一组模拟旧记录和零提交记录：严格物理解码与产物验证保留全部 10 条原事件、四处失败信息及原消息投影；分离的 Session 恢复只追加既有普通续接标记，闭合尾部修复不产生事件。流展开保留可选子树和既有错误码／消息。两版读取器的抛错 fetch 观察器均记录零次调用，未恢复运行 Agent。夹具 SHA-256 为 4957d7c50c2727b6e0e41c076a5f1e29ab70ff3399a19e58a9eda8092a706215。这些检查证明读取兼容性，不代表实时模型重选或提供方可用性。

<a id="dev-note"></a>
## 开发备注

无。
