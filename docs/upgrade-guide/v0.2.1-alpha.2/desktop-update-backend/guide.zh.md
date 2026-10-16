---
kind: upgrade-guide
description: "Desktop 更新检查需要显式打包的 harnes-api 受信地址，不再使用内嵌发布 feed。"
---

# 配置 Desktop 更新后台

[English](guide.md) | 中文

## 变更

Desktop 更新检查从 harnes-api 发现平台目录，不再使用内嵌发布 feed。未配置后台受信地址的发布设置仍可启动应用，但更新检查会报告服务未配置，绝不回落至旧 feed。已下载目标继续绑定选定来源。

## 迁移

1. 在签名发布打包前，将 `apps/desktop/.env.windows` 或 `.env.macos` 中的 `DSH_DESKTOP_UPDATE_CONFIG_ORIGIN` 设置为受信 harnes-api HTTPS origin。已安装应用忽略环境覆盖；更换该地址需要分发已配置的发布版。
2. 在该后台的“客户端更新”设置中启用更新，并配置目标 `mac-arm64`、`mac-x64`、`win-x64` generic Nightly 目录。目录必须提供兼容的签名发布元数据与产物。URL 校验与发现字段见 [Desktop 参考](../../../../apps/desktop/README.zh.md#updates)。
3. 在签名发布版中使用“检查更新”，确认所配平台有响应。禁用、空值、无效与无法连接分别报告失败，不会显示“已是最新”。开发启动器显式默认 `http://127.0.0.1:3000`；覆盖只影响其子进程环境，不启用安装。
