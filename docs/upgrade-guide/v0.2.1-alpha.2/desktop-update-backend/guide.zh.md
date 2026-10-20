---
kind: upgrade-guide
description: "Desktop 更新检查需要显式打包的 harnes-api 受信地址，不再使用内嵌发布 feed。"
---

# 配置 Desktop 更新后台

[English](guide.md) | 中文

## 变更

Desktop 更新检查从 harnes-api 发现平台目录，不再使用内嵌发布 feed。未配置后台受信地址的发布设置仍可启动应用，但更新检查会报告服务未配置，绝不回落至旧 feed。已下载目标继续绑定选定来源。已打包的 macOS 和 Windows 应用（包括未签名包）在受信 feed 确认更高版本后阻断正常产品操作。已确认的要求在检查失败及重启应用后保留；安装仍需下载同意、完整性校验及任务安全重启确认。

## 迁移

1. 在发布打包前，将 `apps/desktop/.env.windows` 或 `.env.macos` 中的 `DSH_DESKTOP_UPDATE_CONFIG_ORIGIN` 设置为受信 harnes-api HTTPS 地址。显式未签名构建缺少此配置时默认使用 `https://8.133.202.230/harness`。已安装应用忽略环境覆盖；更换该地址需要分发已配置的发布版。
2. 在该后台的“客户端更新”设置中启用更新，并配置目标 `mac-arm64`、`mac-x64`、`win-x64` generic Nightly 目录。目录必须提供与所选签名模式兼容的发布元数据与产物。URL 校验与发现字段见 [Desktop 参考](../../../../apps/desktop/README.zh.md#updates)。
3. 在打包发布版中使用“检查更新”，确认所配平台有响应。禁用、空值、无效与无法连接分别报告失败，不会显示“已是最新”。开发启动器显式默认 `https://8.133.202.230/harness`；覆盖只影响其子进程环境，不启用安装。

4. 先通过此前的普通更新流程分发一次包含此行为的应用更新。仅修改 feed 无法让旧二进制获得强制更新能力。确认后续更高版本会显示必须更新界面，完成校验并安装后解除；不能仅凭打包成功就声称已验证实际升级或用户数据保留。
