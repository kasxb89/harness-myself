---
kind: upgrade-guide
description: "提示词准入对已确认的未知型号返回 session/model-unavailable，不再返回 session/agent-busy。"
---

# 未知型号的提示词需要手动重选型号

[English](guide.md) | 中文

## 变更

精确型号解析器以 `UNKNOWN_MODEL` 拒绝已保存选择时，`session.prompt` 现在会在附件准入与提示词入队之前返回 `session/model-unavailable`，并附带可选的 `details.reason: UNKNOWN_MODEL`。此前此失败返回 `session/agent-busy`。其他解析失败保留原分类。解析器支持的型号即使不在选择器目录中也仍可使用。

输入框提示用户选择型号，并保留草稿和附件。选择型号不会自动重新发送提示词。

## 迁移

1. 自定义 JSON-RPC 客户端应在 `session/model-unavailable` 且 `details.reason === 'UNKNOWN_MODEL'` 时提供手动选择型号的入口。保留草稿和附件，直到用户明确再次发送。
2. 确认被拒绝的提示词没有入队，单独切换型号不会发送请求。无需迁移设置或 Session 数据。
