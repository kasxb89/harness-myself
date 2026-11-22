---
kind: upgrade-guide
description: "云枢 Desktop 使用独立的应用身份、浏览器目录和配置根，不再继承另一 Harness 桌面产品的配置。"
---

# 使用云枢独立的 Desktop 配置

[English](guide.md) | 中文

## 变更

云枢 Desktop 使用打包名称 `yunshu-desktop`、产品应用 ID `com.yunshu.desktop` 和 `yunshu://open`，可选终端命令为 `yunshu`，不再注册上游的 `dsh` 命令或 URL 协议。默认 Electron 浏览器目录为 `appData/yunshu-desktop`；配置根为 `$DSH_HOME/products/yunshu`，逻辑名称为 `desktop` 的 profile 位于其下的 `profiles/desktop`。

profile patch、主目录 patch、旧设置导入、热重载和 Desktop 内置插件命令统一使用此配置根。旧 `$DSH_HOME/cordis.patch.yml`、`$DSH_HOME/settings.yaml` 和 `$DSH_HOME/profiles/desktop` 覆盖配置不再生效。Desktop 从安装包中的 bundle 初始化新 profile，不自动复制旧的已启用扩展或模型配置。

账号登录、会话、任务状态和用户文件保留原有位置。此变更不复制登录凭据、不轮转刷新令牌、不重放任务，也不会将 CLI dsh 的全部业务数据目录独立出来。

## 迁移

1. 发布操作人员必须在相应的 Desktop 发布配置中设置 `DSH_DESKTOP_APP_ID=com.yunshu.desktop`。打包拒绝精确使用上游的 `com.deepseek.harness` 和 `com.deepseek.dsh`。源码检查不能证明跨 ID 的已安装升级可用：发布新身份前，必须在每个发布目标上验收旧云枢安装、与 DeepSeek Harness 共装、更新、重启和卸载的实际行为。
2. 首次升级前退出两个桌面应用，保留既有 `$DSH_HOME` 和登录文件。直接启动安装后的 `Yunshu.exe` 或云枢应用包，不要通过通用 `dsh` 命令或旧产品快捷方式启动。
3. 在云枢自己的设置和插件管理器中重新保存仍需使用的手动提供方或逐模型覆盖，并显式启用可信扩展。不要把旧 `profiles/desktop` 目录或全局 patch 整体复制到新配置根，否则会恢复冲突。原文件保留，可供核对。
4. 把打开应用的链接改为 `yunshu://open`。确认云枢与 DeepSeek Harness 各自打开独立窗口，重启后仍保留各自配置，再确认既有云枢账号和会话仍可使用。存储归属见 [Desktop 参考](../../../../apps/desktop/README.zh.md#installation-ownership)。

5. 通过**管理 yunshu 命令…**在 macOS 安装 `/usr/local/bin/yunshu`，或在 Windows 注册 `yunshu.cmd` 的 PATH 入口，再打开新终端运行 `yunshu --version`。云枢不会替换或移除旧的通用 `dsh` 注册；不再需要时应单独核对该注册。
