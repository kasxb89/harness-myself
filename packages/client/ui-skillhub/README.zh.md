---
description: "从产品侧边栏搜索 SkillHub 社区，并将技能安装到产品中。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skillhub

[English](README.md) | 中文

## 概述

在侧边栏的技能商店搜索社区技能，安装明确选定的技能，并查看已安装列表。搜索和安装在产品私有存储中使用官方 SkillHub CLI。已安装技能无需重启即可用于现有会话。商店不修改其他应用的技能或安装源偏好。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Web 产品 bundle 挂载本包。打开**技能商店**，输入技能名称或任务，提交搜索，再在目标结果上选择安装。已安装标签列出产品管理的成功安装。进入页面或搜索不会自动安装技能，已有目标目录会阻止安装。

首次需要 CLI 的操作会下载官方 2026.8.5 版本包，并核验锁定的 SHA-256 和四个选定文件。缓存位于当前 Harness 缓存下的 `skillhub` 目录。Desktop 解析并传入已验证的捆绑 Python 可执行文件，因此 Windows 无需系统 Python 或 Bash。没有该运行时的独立 Web 部署使用配置的 `pythonExecutable`。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `skillsDirectory` | 必填 | 产品用户技能的绝对目录 |
| `cacheDirectory` | 必填 | 产品私有 CLI 缓存与状态的绝对目录 |
| `pythonExecutable` | `python3` | Desktop 使用已验证的捆绑 Python，Web 使用配置的解释器 |
| `timeoutMs` | `120000` | 完整操作的截止时间，单位毫秒 |
| `searchLimit` | `20` | 社区搜索结果数量上限 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-client-ui-skillhub)列出全部执行限制。[官方安装说明](https://skillhub.cn/install/skillhub.md)介绍 SkillHub 的独立 CLI；本集成传入产品私有暂存目录，不使用 CLI 默认的相对目录，再将验证后的文件提交到产品技能目录。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

浏览器注册带键的主面板，并在广场和插件之间增加侧边栏入口。经过鉴权的本地 Connection 路由负责搜索、安装和清单读取。Host 通过子进程服务执行未修改的官方 CLI，隔离配置并禁用自升级。小型 Python 适配器将社区搜索失败明确报出。不会向 SkillHub 传递上游账户凭据或产品 relay 凭据。

安装在私有暂存目录中完成，再发布完整技能。包含命名空间的社区规范名称保留在官方锁文件中；当前 Harness 主目录的 `skills` 下使用确定性的单层目录，让现有文件系统提供方能够发现技能。提交成功后使 Host 目录和浏览器技能引用缓存失效。卸载插件会取消并等待活动操作结束，并移除路由、面板和字典。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [文件系统技能](../../skill/skill-filesystem/README.zh.md)——发现与失效。
- [技能引用](../ui-skill/README.zh.md)——会话内的技能选择。
- [侧边栏](../ui-sidebar/README.zh.md)——产品导航。
- [捆绑依赖](../../skill/tool-workspace-dependencies/README.zh.md)——已验证的 Python 运行时。

<a id="model-experience"></a>
## 模型体验

### 技能可用性

#### 模型能看到什么

商店不贡献工具或会话消息。已安装的 `SKILL.md` 文件进入现有文件系统目录，其自身元数据和调用规则决定模型何时读取内容。

#### Token 影响

导航、搜索和安装不发起模型请求。后续技能使用遵循现有技能目录与正文加载规则。

#### KV Cache 影响

商店不组装提供方请求。技能目录变化可能经由现有技能系统改变后续模型上下文。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

本页面管理通过产品安装的社区技能。

- 不提供企业登录、付费购买、技能升级或移除功能。
- 未捆绑运行时的 Web 部署需要可用的已配置 Python 可执行文件。
- 技能发布后若锁文件写入失败，会报告失败并保留已发布文件供检查。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
