---
description: "与真人工程师进行私有需求沟通、发送媒体附件并确认交付。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-demands

[English](README.md) | 中文

<a id="summary"></a>
## 概述

侧边栏「需求发布」展示实际工程师目录和当前登录用户的私有需求。用户以聊天描述工作、附加图片或视频、继续历史需求，并确认工程师的交付。工程师上架、分派、权限和处理状态由后台管理。

<a id="table-of-contents"></a>
## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

浏览器插件与 slots、locale、layout 和既有 Credits 账号数据源一起装配，Web 配置已包含本包。本地载体设置 `enabled` 默认开启传输能力；后台的 `config.enabled` 决定是否接受新需求。旧后台没有需求接口时显示不可用。服务关闭后保留已读取的历史，并以服务器当前权限为准，不虚构工程师，也不删除旧需求。

`requestTimeoutMs` 限制单次元数据请求的时长；`uploadTimeoutMs` 单独为较慢的二进制上传分片留出时间。`foregroundPollMs`、`backgroundPollMs` 和 `listPollMs` 控制刷新间隔。后台上传规则提供 MIME 类型、附件数量、图片和视频各自的大小上限，以及续传分片大小。用户通过现有账号页面登录，本包不建立另一套登录。

<a id="understand-the-implementation"></a>
## 理解实现

账号拥有的控制器向框架绑定的注入 hook 发布稳定 JSON 视图。组件只持有搜索、标签和窄屏导航状态。账号或登录代次变化时立即清空旧视图，取消其请求和上传；响应必须与发起时的账号一致。卸载会取消并等待全部自有异步操作结束。

请求经本机鉴权代理 `/credits/api/demands` 转发，凭证及续期仍由 [credits-index](../../host/credits-index/README.zh.md) 负责。令牌保留在 Host。媒体元素使用本机附件标识和账号守卫，Host 重新授权内容访问，并透传 Range 响应以支持视频拖动播放。

每次新需求、消息、上传和验收在发送前保存账号隔离的持久操作标识及冻结请求正文。响应丢失时保留原操作进行准确重试，不更换标识重复提交；不同草稿彼此独立。消息发送成功和已读状态来自服务端回执。图片、视频按有界 `File.slice` 分片上传，分片结果不明时先查询偏移。重新选择文件后，先校验元数据与已记录分片的摘要再继续。文件内容不放入 JSON 视图或本地操作记录。

<a id="further-exploration"></a>
## 进一步探索

- [Credits Host](../../host/credits-index/README.zh.md)——账号绑定的需求代理和媒体访问。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——可观察数据和展示职责。
- [侧边栏](../ui-sidebar/README.zh.md)——导航扩展。

<a id="model-experience"></a>
## 模型体验

<a id="human-engineer-requests"></a>
### 真人工程师需求

<a id="what-the-model-sees"></a>
#### 模型看到什么

`demands` 面板不添加提示词、工具、模型消息或 AI Session。客户沟通属于独立的需求服务。

<a id="token-effect"></a>
#### Token 影响

真人消息及附件操作不发送模型请求，也不进入 AI 生成计费链路。

<a id="kv-cache-effect"></a>
#### KV Cache 影响

需求导航和消息不改变模型上下文或提供商缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 工程师、上架、分派和私有附件存储依赖对应后台业务。
- 应用重启后，未完成的上传需要用户重新选择原文件。
- 本地操作记录要求浏览器存储可用；存储不可用或内容无效时，在发送前阻止新写操作。
- 报价、支付、合同和退款不属于本包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护人员工作背景（点击展开）</summary>

无。

</details>
