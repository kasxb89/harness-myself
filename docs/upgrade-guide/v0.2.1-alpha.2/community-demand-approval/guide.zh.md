---
kind: upgrade-guide
description: "公开需求的发现、发布和接单要求后台支持审核能力。"
---

# 社区需求审核

[English](guide.md) | 中文

## 变更

需求广场要求 `/api/product/community-demands/config` 明确返回 `capabilities.community_approval_v1: true` 和 `publication_policy: approval_required`。旧后台不能向此客户端提供公开广场或接收新的公开提交。原参与人的历史和待确认操作恢复仍可使用。旧需求可见不代表已通过审核。

## 迁移

1. 分发客户端前先提供兼容后台，保留原数据库、认证密钥、登录会话和请求回执。
2. 在社区需求管理中逐条审核原公开需求；修改可见状态不会通过审核。
3. 确认新需求在待审期间只出现在「我的需求」，通过审核后才可在公开广场发现。同时核对原会话和待确认操作仍可恢复，不会创建替代请求。
