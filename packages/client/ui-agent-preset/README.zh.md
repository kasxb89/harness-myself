---
description: "在 Web 中选择 Agent preset 和新任务默认值，查看各模式的说明与声明的配置。创建与修改引导至创造模式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-preset

[English](README.md) | 中文

## 概述

在 Web 中选择 Agent preset 和新任务默认值，查看各模式的说明与声明的配置。创建与修改引导至创造模式。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

设置页显示内置与自定义卡片分组、默认项高亮和点击卡片选择；没有 preset 的分组不显示，但自定义分组会保留其创造入口。每张卡片都提供「查看配置」，以只读 YAML 打开该 preset 声明的插件列表，使用 Loader 自己的方言（含 `!!js` 条件）；加载失败的 preset 同样可读，因为其诊断信息正指向这份 YAML。Escape 只关闭查看器并将焦点还给卡片；离开设置页会清空查看器，迟到的读取结果不会重新打开它。本页不编辑任何内容：创造入口启动一个创造模式任务，以 bundle 形式创建或覆盖 preset；当 `cordis` preset 在列表中且存在会话流程时提供。

关闭通用设置中的代码工作工具后，新会话选择器和设置页列表提供标准、创造和自定义预设；开启后还提供 PTC 和极简模式。两种状态下均保留默认值选择和创造入口。选择健康定义作为默认值也会同步当前新任务页面的空白会话。Creator 入口开启一个使用 `cordis` preset 的新任务。

关闭代码工作工具时，沿用现有 Developer tools 订阅清空所有尚未应用的选择。关闭状态被接受后，使用 Host 持久化设置的连接会将已保存的内置 PTC 或极简默认值回退为标准模式。已保存的标准、创造和自定义默认值（包括有名称的 PTC 或极简覆盖项）保持不变。关闭后用户仍可重新选择可用预设。已有会话保留所选模式；新会话使用当前默认值。即使已有会话的模式不在菜单中，其标签仍会显示。重新开启代码工作工具不会恢复原默认值或已清除的选择。使用内存设置的远程连接不会改写 Host 的默认值。标准模式缺失或损坏时，默认值保持不变，并显示错误。

已知的内置预设提供只读的模式说明与使用示例对话框。各页签保留各自的滚动位置；关闭后焦点回到打开它的操作。帮助不会改变新任务默认值。默认徽标取代卡片的分组徽标，预设 id 显示在标题旁。指南文案与示例归本包所有。

插件页**添加插件**箭头菜单中的**让 Agent 创建插件**进入与设置页相同的创造流程，不发送消息，并保留未发送的草稿。读取预设列表或创造模式不可用时，菜单项禁用并说明原因。Host 拒绝切换预设时，两处入口均通过 Toast 显示原因。

进入创造模式会为接收该选择的空白 Session 选择 `cordis`，不改变新任务默认值或代码工作工具设置。尚未绑定工作区或空白 Session 时，选择等待绑定完成后应用。应用后，创造 Session 保留该预设；之后真正创建的新 Session 使用配置的默认值，例如标准模式。

侧边栏的**数字员工**页面将同一份 Host 列表中的行业岗位与用户自建预设分组展示，支持按名称和职责搜索。对内置标识的具名覆盖仍会显示。已安装的 custom-mode 编辑器注册设置分区后，**自定义员工**打开该编辑器，不创建或复制预设。长描述不会撑开卡片。列表刷新失败时保留已有卡片并提供重试，空列表显示空态。**开始对话**以选定员工打开普通聊天草稿，保留未发送草稿、工作区模型和账户，不发送消息、不修改默认值，也不切换正在运行的 Session。会话中的预设选择器也提供这些员工。图片和视频任务使用产品现有的创作工具。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

`agentPresets/list` 提供列表并标记当前默认值，`agentPresets/read` 为查看器提供一条声明的 YAML；默认值的修改写入 `agent-preset-registry` settings 命名空间。选择器、空白会话同步和只读会话标签使用记录的 preset 标识。连接重置和设置更新会刷新列表。

`CreatePluginMenuItem` 使用共享的预设列表 store，向 `plugins.add.actions` 贡献菜单项。选择时先调用页面传入的 `onDismiss()`，再调用与设置页 `creatorDraft` 相同的 `startCreatorDraft` 回调。该回调通过 `AgentPresetSeatController` 暂存 `cordis`，再通过显式保留草稿的 `uiWorkspace.startSession` 调用打开任务；它可以复用空白 Session，并在 Session 绑定可用时应用暂存选择。暂存选择应用后即清除。代码工作工具开启或关闭时均使用同一个选择器和选择 store，`AgentPresetSeat` 通过共享的 `Toast` 组件显示拒绝原因。

`EmployeePage` 读取同一个 `AgentPresetSettingsController` 快照，排除无名称的内置预设，将 `employee-` 标识归入内置岗位，其余自建预设归入我的员工。编辑器操作观察 `settings.section` 账本，仅对已安装的 `custom-system-prompt` 分区发出具备类型约束的 `ui-settings/open-section` 事件。本地事件 `ui-settings/closed` 触发现有刷新流程，重读已挂载的页面、预设设置分区和会话选择器，使编辑器的新增、改名与删除立即显示，无需页面跳转或轮询。其 `main` 与 `sidebar.panellist` 注册由会话流程的生命周期管理。员工和创造入口共用暂存选择、工作区导航及空白会话应用流程；页面只持有自身的搜索内容。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Scope](../../core/scope/README.zh.md) — 注册隔离。
- [Agent](../../core/agent/README.zh.md) — 会话运行时。
- [Cordis](../../../docs/cordis-primer.zh.md) — 插件配置与生命周期。

<a id="model-experience"></a>
## 模型体验

通过选定的 preset 间接影响模型，其插件拥有模型可见能力。

#### KV Cache effect

选择变更只影响之后的任务，已有插件与提示词保持不变。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- Web 不创建也不编辑 preset：配置查看器是只读的；通过创造模式安装的 bundle 声明新 preset，或按行 id 覆盖内置 preset，覆盖会替换整个子插件列表。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
