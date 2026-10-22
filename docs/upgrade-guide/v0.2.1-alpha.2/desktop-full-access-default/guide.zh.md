---
kind: upgrade-guide
description: "Desktop 新建会话由工作区权限改为默认完全权限。"
---

# Desktop 会话默认使用完全权限

[English](guide.md) | 中文

## 变更

Desktop 新建会话由 `workspace-write`、审批 `ask` 改为 `danger-full-access`、审批 `never`。这些会话不再受 Harness 文件沙盒的工作区限制，操作系统权限仍然生效。已有会话保留原权限。已保存的用户默认值、显式 `DSH_PERMISSION_MODE` 或 profile 配置继续覆盖产品默认值。Web、headless 与 SDK 默认值不变。

## 迁移

1. 若要让后续会话继续使用工作区权限，在**设置 → 通用设置 → 权限**选择**工作区内修改**。部署方也可在启动 Desktop 前设置 `DSH_PERMISSION_MODE=workspace-write`。没有显式覆盖项时，无需操作即可使用新的完全权限默认值。
2. 新建会话并检查权限选择器，应显示**完全权限**或你明确选择的较低权限。需要修改已有会话时，通过该会话自己的权限选择器操作；升级不会自动改变它。
