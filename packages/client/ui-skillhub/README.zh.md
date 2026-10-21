---
description: "从产品侧边栏搜索 SkillHub 社区，并将技能安装到产品中。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skillhub

[English](README.md) | 中文

## 概述

在侧边栏的技能商店浏览推荐社区技能、按任务搜索、安装明确选定的技能，并查看已安装列表。目录读取和安装在产品私有存储中使用官方 SkillHub CLI。已安装技能无需重启即可用于现有会话。商店不修改其他应用的技能或安装源偏好。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Web 产品 bundle 挂载本包。打开**技能商店**后，搜索框下方会加载 SkillHub 官方推荐榜中的社区条目。发现技能和已安装标签位于标题下方，与搜索和结果对齐在同一内容列。推荐保留官方顺序，排除企业和外部来源条目。可以按技能名称或任务搜索，再返回推荐，无需重复搜索。推荐读取失败时可重试，仍可继续搜索。在目标卡片上选择安装；已安装标签列出产品管理的成功安装。进入页面、浏览推荐或搜索不会自动安装技能，已有目标目录会阻止安装。

卡片使用本地装饰图标，标题显示两行、介绍显示三行。选择详情可在可滚动弹窗中查看完整条目；Escape 关闭弹窗并恢复焦点。已加载结果每页最多显示 12 项，翻页不增加目录请求。

首次需要 CLI 的操作会下载官方 2026.8.5 版本包，并核验锁定的 SHA-256 和四个选定文件。缓存位于当前 Harness 缓存下的 `skillhub` 目录。Desktop 解析并传入已验证的捆绑 Python 可执行文件，因此 Windows 无需系统 Python 或 Bash。没有该运行时的独立 Web 部署使用配置的 `pythonExecutable`。

在 `recommendationsCacheMs` 内重新打开商店会复用成功的公共推荐榜，不再启动 Python 或联网。显式“重试”绕过缓存；过期缓存与失败响应不会作为兜底返回。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `skillsDirectory` | 必填 | 产品用户技能的绝对目录 |
| `cacheDirectory` | 必填 | 产品私有 CLI 缓存与状态的绝对目录 |
| `pythonExecutable` | `python3` | Desktop 使用已验证的捆绑 Python，Web 使用配置的解释器 |
| `timeoutMs` | `120000` | 完整操作的截止时间，单位毫秒 |
| `recommendationsCacheMs` | `60000` | 成功公共推荐榜的内存缓存时长；0 表示禁用 |
| `searchLimit` | `20` | 每次搜索或推荐列表的社区技能数量上限 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-client-ui-skillhub)列出全部执行限制。[官方安装说明](https://skillhub.cn/install/skillhub.md)介绍 SkillHub 的独立 CLI；本集成传入产品私有暂存目录，不使用 CLI 默认的相对目录，再将验证后的文件提交到产品技能目录。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

浏览器注册带键的主面板，并在广场和插件之间增加侧边栏入口。经过鉴权的本地 Connection 路由负责推荐读取、搜索、安装和清单读取。推荐使用官方 CLI 的推荐榜，并保留带命名空间的安装坐标。推荐与搜索请求各自管理生命周期，晚到的推荐不会替换搜索结果。Host 通过子进程服务执行未修改的官方 CLI，使用 Python 隔离配置（`-I`）、显式 UTF-8 模式（`-X utf8`），并禁用自升级。显式 UTF-8 模式使中文和 emoji 输出不依赖 Windows 的 ANSI 编码；隔离模式会忽略 `PYTHONIOENCODING`。小型 Python 适配器将社区搜索失败明确报出。不会向 SkillHub 传递上游账户凭据或产品 relay 凭据。

安装在私有暂存目录中完成，再发布完整技能。安装时将 `SKILL.md` 前置元数据中的名称转为小写，例如将 `Writing` 转为 `writing`，其余元数据、注释和正文保持不变；商店仍保留官方显示名称。包含命名空间的社区规范名称保留在官方锁文件中；当前 Harness 主目录的 `skills` 下使用确定性的单层目录，让现有文件系统提供方能够发现技能。提交成功后使 Host 目录和浏览器技能引用缓存失效。卸载插件会取消并等待活动操作结束，并移除路由、面板和字典。

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
- 安装仅规范名称大小写；其他非法技能名称或缺少必需前置元数据字段会阻止发布。需要规范的名称不能带有 YAML 锚点，因为更改它也会改变通过别名引用的元数据。
- 技能发布后若锁文件写入失败，会报告失败并保留已发布文件供检查。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
