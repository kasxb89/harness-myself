---
description: "授权本地账号、余额和媒体请求，查询小时用量，辅助编写提示词，并合成可恢复的视频项目。"
kind: "package-reference"
---

# 额度 Host

[English](README.md) | 中文

## 概述

使用当前登录的产品账号查询余额、充值、分析用量并生成媒体。提示词帮写准备可编辑的图片或视频描述，不提交媒体生成。工作区视频项目规划模型支持的片段，依序生成，再发布经本地验证的成片。付费请求使用当前账号；取消不能保证已被上游接受的任务停止计费。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

额度 Host 通过校验本机来源的 `/credits` 路由转发账号、余额、充值和媒体操作。部署 API 根地址为 `https://8.133.202.230/harness`，模型请求使用其 `/v1` 后缀。所有上游请求均保留完整前缀，拒绝此 IP 根路径的 `/api` 和 `/v1`，不跟随重定向，并启用正常 HTTPS 证书校验。

### 账号会话

手机验证码与登录使用配置根地址下的 `/api/user/phone/challenge` 和 `/api/user/phone/login`。登录返回短期管理凭据 `access_token`、轮换的 refresh cookie 和账号专属 `relay_key`，模型请求仅使用该 relay key。Host 私密保存这些凭据，将会话绑定至后端根地址，并在管理凭据临近过期时等待同一次共享续期完成。续期和退出声明后端 Origin。Host 通过实时 `harnessAccount` 为产品模型路由授权；已存凭据或环境变量引用不能替代有效会话。退出会立即移除这项授权；并发的旧续期不能恢复它。将已存会话切换到另一后端时，需要重新手机登录。

### 聊天模型刷新

每次列出产品路由模型前，先等待当前账号的 `harnessAccount.refreshModels` 结果。Host 使用该账号的 relay key 读取 `/v1/models`，排除已声明的媒体生成模型，并在适配器读取配置前同步非空聊天结果。并发读取共享同一次操作。成功返回空列表时不展示任何聊天模型，即使旧 profile 仍保留配置；读取不可用时返回目录失败，不把旧模型显示为当前可用。其他提供方路由保留原有的列表行为。

启动和每 60 秒的定时器复用同一刷新操作。登录变化和退出会取消旧发现；提交前检查登录代次、已存会话身份、后端和有效期。卸载会取消并等待未结束的发现操作。界面可以请求新目录，无需等待定时器。公开定价仍用于描述媒体参数，账号模型端点决定其聊天列表；已声明或已选择的模型仍可能被上游的权限或计费校验拒绝。

### 充值

`POST /credits/api/recharge/wechat` 接受以元为单位的整数 `amount`，使用当前账号的 access token 创建一笔 Native 订单。响应提供 `outTradeNo`、`amount`、换算后的 `points`、`expiresAt` 和 `qrCodeDataUrl`；原始 quota 不是积分。提交订单前必须取得当前状态参数进行换算。下单结果未知时会明确报告，不自动再创建一笔订单。

`GET /credits/api/recharge/wechat/order?outTradeNo=...` 查询同一账号的订单。Host 原样转发后端状态，不设置别名，并附加换算后的积分。客户端将未知状态报告为待人工核对，不宣称支付成功。支付回调直接进入部署 API，由其负责给账号入账；产品仅在确认支付后刷新实时余额。

### 使用量分析

`GET /credits/api/usage?start=<seconds>&end=<seconds>` 返回当前登录账号按小时和模型汇总的用量。两个参数均为包含端点的正整数 Unix 秒，完整区间最多为 31 天。客户端先选择显示时区，再将自然日换算成秒。重复参数、账号选择参数和其他查询参数均被拒绝。

成功响应使用额度封装 `{ ok: true, payload: ... }`。payload 包含 `rows`、`start`、`end`、`asOf`（读取时刻的 ISO 时间）和 `delayMinutes: 0`。每行包含 `timestamp`、`model`、`billingRecords`、`consumedPoints` 及 `totalTokens`。Host 按小时和模型归并消费账单记录；零延迟字段表示不再等待旧聚合导出，不保证新扣费立即出现。消费记录数不等于请求数，单独记录的退款不从此处扣减。

Host 先使用 `/api/user/self` 核对产品会话中的账号，再通过 `/api/log/self?type=2&p=1&page_size=100` 读取选定区间的全部分页。它校验分页、账号身份、quota、token 字段及 JSON 字符串 `other`。失败、不完整或不一致的读取不会产生部分结果。管理员 token、账号搜索及部署凭据均不能替代当前登录账号。

实时 `/api/status` 读取提供 `quota_per_unit` 和 `usd_exchange_rate`。积分按 `quota / quota_per_unit × usd_exchange_rate × 1000` 计算，两个后端参数均没有写死的回退值。换算设置缺失或无效、源数据不可用或无效时，返回 `{ ok: false, code, message }`，不以零值替代。客户端负责可见错误提示和重试，读取不可用时保留之前的显示。

使用量读取共用本机来源校验、`timeoutMs` 和包含完整部署前缀的 `newApiBaseUrl`，仅使用当前账号的 access token。服务不可用时，产品不读取缓存 quota 或其他账号的余额。

### 提示词帮写

`POST /credits/api/prompt/assist` 仅接受 `{ accountId: string, kind: 'image' | 'video', prompt: string, instruction: string, references: string[], generation: Record<string, string> }`。Host 将 `accountId` 与有效产品会话比较，不匹配时在查询任何模型前返回 `ACCOUNT_CHANGED`；此字段绝不进入模型输入。当前原稿、修改意见及生成参数摘要构成模型输入。PNG、JPEG 和 WebP 参考图必须是现有本机 `ma_` 资产；任意 URL、视频，以及客户端选择的路由或凭据均被拒绝。图片以内联聊天图像内容发送。成功的额度响应封装在 `payload` 内包含 `{ prompt, model }`；失败包含稳定的 `code`，绝不返回上游响应正文或异常。客户端核对原稿与账号后，将成功的帮写结果直接写入可编辑的创作提示词；请求失败时保留当前原稿。帮写不会提交媒体生成。

通过 `promptAssistantModel` 配置纯文本帮写，通过 `promptAssistantVisionModel` 配置带参考图的帮写。两项默认均为空，接受最多 256 个非空白字符的模型标识。未配置会明确返回 `PROMPT_ASSIST_NOT_CONFIGURED`。视觉支持由部署者显式声明，绝不根据模型名称或缺失的目录元数据推断。每次生成前，Host 仅使用当前账号的中转 key，通过 `/v1/models` 核对所选模型，拒绝缺失模型及被声明为图片或视频生成器的条目。随后使用同一 key 调用 `/v1/chat/completions`。已过期产品会话会先被清除；未登录或缺少中转凭据时停止请求。部署目录 key 绝不作为回退。后台续期访问 token 时，只有上游响应确认相同账号 ID，才保留现有中转凭据；ID 不同或缺失时，已存会话保持不变。

请求 JSON 上限为 32 KiB；原稿最多 7,000 字符；修改意见最多 2,000 字符；参数摘要最多 16 个字符串条目，键最多 64 字符、值最多 256 字符。必须至少提供原稿、修改意见或参考图。最多六张不同参考图，合计不超过 15 MiB，单张不超过 6 MiB；MIME 与图片签名必须匹配。生成响应正文及账号目录上限为 64 KiB，最终提示词上限为 7,000 字符，生成上限为 2,048 tokens。`promptAssistantTimeoutMs` 为整个操作提供独立于其他 API 的统一截止时间，默认为 60,000 毫秒，接受 1 到 120,000 毫秒的整数；断开连接或插件 dispose（资源释放）会取消上游工作，dispose 等待请求结束。不自动重试上游请求。发出聊天生成后，超时、传输故障、取消或上游报错均返回 `PROMPT_ASSIST_RESULT_UNKNOWN`，表示结果未知且可能已经计费。无效的生成数据同样提示可能计费；用户应先查看用量，再决定是否重试。模型目录阶段失败时尚未发出聊天生成。

调用模型前，Host 将账号 ID、所选模型、token 上限、准确的系统和用户文本，以及参考图元数据保存到 `stateDir/prompt-assists/<random-request-id>/request.json`。`prompt-assists/references` 下按内容寻址的图片文件，为每个 SHA-256 摘要保留一次不可变字节；普通上传可能覆盖资产 ID，因此不足以重建请求。目录权限为 `0700`，文件为 `0600` 且以独占方式创建。`outcome.json` 仅保存经过校验的候选或安全失败码，以及是否已发出聊天生成，不包含凭据及上游原始响应。输入记录失败会阻止发送；结果记录失败返回 `PROMPT_ASSIST_RESULT_STORAGE_FAILED`，表示可能已经计费但候选不可用。崩溃可能留下没有结果的请求；记录保留到部署者主动删除，不自动清理。这个独立媒体流程不添加 Session 格式或 agent loop（智能体循环）行为。

### 创作内容发布

`GET /credits/api/creation/content` 将部署后台的公开文档转发为 `{ ok: true, payload }`。`GET` 与 `HEAD /credits/api/creation/assets/:id` 转发不可变的 `cc_` 内容哈希图片和视频，支持单个字节范围读取。这些读取校验来源，使用 `newApiBaseUrl` 与 `timeoutMs`，不发送账号或部署凭据，拒绝上游重定向及不符合预期的 MIME 类型，文档上限为 5 MiB，媒体上限为 100 MiB。连接断开或插件卸载会停止传输，卸载等待操作结束。错误仅公开 `CREATION_CONTENT_UNAVAILABLE`，绝不返回上游正文。[创作内容读取器](../../client/creation-content/README.zh.md) 负责文档校验、刷新及使用方状态。

### 视频能力与参考素材

视频提交和状态查询使用所选能力的 `route`；公开定价明确指定的路由优先。MiniMax-H3 使用 `POST /v1/video/generations` 和 `GET /v1/video/generations/:id`，其他视频模型保留原有协议。`data` 内的通用任务响应支持大写 `NOT_START`、`SUBMITTED`、`QUEUED`、`IN_PROGRESS`、`SUCCESS` 和 `FAILURE`。成片通过 `/v1/videos/:id/content` 读取，保留配置中的 `/harness` 前缀，并使用当前账号的中转 key。渠道的聊天测试不能验证视频生成。

视频菜单优先读取公开定价 `parameters`（字段映射或 JSON Schema 的 `properties`）中明确的 `seconds` 或 `duration` 声明，其次读取 `billing_usage_schema`。数值枚举或有限的 `minimum`/`maximum` 范围选出 1 至 3600 秒内的整数，并覆盖模型表；排他边界和 `multipleOf` 进一步缩小时长菜单。缺失、格式错误或无上限的声明保留已知模型限制；计费样例不授予时长或额外参考槽位。分辨率枚举和常量使用相同的实时优先级。当前 H3 响应只声明未限定范围的数值秒数字段，因此保留已知的 4–15 秒菜单。公开定价列出某个模型，不代表特定账号已可用它生成。

明确的 `oneOf` 将 `properties.resolution.const` 或 `.enum` 与有限的 `properties.seconds` 或 `.duration` 配对。得到的 `durationByResolution` 菜单同时约束面板请求和项目规划；未列出的分辨率不可用，并且必须选择分辨率。例如，生产方可以明确发布 480P/768P 为 4–30 秒、2K 为 4–15 秒的两个分支。这说明解析器支持的格式，不表示当前 API 或尚未明确的上游支持这些组合。Host 在模型提交前拒绝不支持的组合、小数或非数值时长。

本机 `/credits/api/assets` 接受 MIME 与文件签名相符的 PNG/JPEG/WebP 图片、MP4/MOV 视频和 MP3/WAV 音频。单文件上限分别为图片 6 MiB、视频 32 MiB、音频 15 MiB；一次生成中的全部图片总计不超过 12 MiB，全部参考素材原始字节总计不超过 48 MiB，编码后的完整生成请求不超过 64 MiB。只有所选模型声明了音频参考槽位时才展示音频。H3 的所有参考素材放入同一个完整的 `metadata.content` 数组。H3 首尾帧不能与通用参考素材混用。自适应比例要求实际图片或视频输入。这些校验不会完整解码媒体，也不证明上游生成能力。

### 本地视频剪辑

项目剪辑器使用桌面端提供的 `DSH_VIDEO_RUNTIME_ROOT` 目录，不搜索 PATH。付费生成前会验证两个可执行文件，并在选定输出目录实际执行一次 H.264/AAC 编码，拒绝只读或逃逸的输出目录。每个进程均经过当前会话的子进程服务和已解析的沙箱策略，不拼接 shell。输入必须是工作区内的普通文件，或项目所有者已授权的确切私有片段目录中的普通文件；私有片段路径拒绝符号链接。当前聊天附件位于工作区之外时，模型先通过现有文件工具把已获读取权限的附件复制进工作区。协议访问仅允许本地文件和管道。

剪辑保留原片，按明确的开始和结束时间裁剪，将画面等比缩放并补边到首段画布（或部署时明确指定的画布），并将尺寸取为偶数，转换为配置的帧率，并将音轨统一为双声道 48 kHz。没有音轨的片段补静音。片段默认硬切拼接，不添加转场、字幕或配乐。可选的成片时长会裁掉拼接结果的末尾，素材不足则明确拒绝。FFprobe 在成片以独占、同卷原子方式发布前核对时长；已有目标文件不会被替换。取消和超时会终止并等待受管进程范围退出，再清理临时文件。剪辑失败不会发布候选文件；已经完成的原片保留，可在后续剪辑中复用。

<a id="video-projects"></a>
### 视频项目

工作区聊天可通过 `generate_video_project` 制作超过所选模型单段时长上限的完整视频。规划器先最小化计费片段数量，再最小化多余秒数：模型支持对应时长时，40 秒请求使用 `15 + 15 + 10`；仅支持固定 15 秒时生成三段，并裁剪为 40 秒。首次计费提交前，系统验证所有分镜请求和本地剪辑工具。可选分镜说明的数量必须与规划片段数相同；上传引用编号和可读工作区素材均经过当前会话校验。生成只使用当前登录账号的中转凭据，每次提交前核对捕获的账号与登录状态；退出、过期或切换登录会阻止后续新增计费。

项目使用已有的会话所属后台任务。工具返回规范的 `job_id`、`project_id` 和 `plan_seconds`；现有任务工具负责读取进度和取消。最终成功结果只包含经独立验证且实际保存的 `final_path` 和片段路径。代理通过现有 `present` 工具和可点击的产物链接交付最终文件。本地取消会停止后续提交和本地处理；中转服务没有取消操作，已被上游接受的任务可能继续运行和计费。

`stateDir/video-projects/<project_id>/manifest.json` 中的私有记录仅所有者可读写，保留账号编号、非秘密登录指纹、所属聊天与工作区、原始说明和完整已准备请求、分镜计划、上游任务编号、已保存片段路径及最终状态。每次提交前以及任务编号和片段保存后均原子替换记录；记录不含凭据或上游原始响应。下载片段保存在私有项目缓存，仅通过受沙盒约束的本地剪辑将最终文件发布至工作区内的 `videoProjectOutputDirectory`。记录和素材不自动清理。`video_project_status` 按账号、聊天和工作区校验读取权限。进程重启后保留的是记录，不会虚构仍在运行的任务；显式调用 `resume_video_project` 会复用已保存片段、读取已知任务编号，再决定是否提交从未提交的剩余片段。没有已持久化任务编号的提交属于未知结果，可能已计费，绝不自动重提；失败的上游任务同样需要明确创建新项目，或剪辑已保留片段。

可配置 `videoProjectMaxSeconds`（默认 300）、`videoProjectMaxSegments`（32）、`videoProjectPollIntervalMs`（6000）、`videoProjectTaskTimeoutMs`（900000）、`videoProjectDownloadMaxBytes`（536870912），`videoProjectReferenceMaxBytes`（每个本地引用 20971520），以及相对于工作区的 `videoProjectOutputDirectory`（`artifacts/videos`）。生成前，完整记录连同任务与路径元数据的预留空间必须不超过 64 MiB。这些限制在计费前生效。镜头连贯性仍取决于提供方；管线提供有序分镜说明与共享参考素材，不会承诺模型尚未生成的主体一致性或转场画面。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[宿主入口](src/index.ts) 将本地 HTTP 路由连接到经过账号授权的上游操作。[提示词帮写](src/prompt-assist.ts) 负责候选生成，[视频项目](src/video-project.ts) 保留有序生成与恢复状态，[本地剪辑器](src/video-edit.ts) 负责子进程合成。浏览器面板共用这些宿主操作，不处理上游凭据。

</details>

<a id="further-exploration"></a>
## 延伸阅读

- [Webserver](../webserver/README.zh.md)：HTTP 请求载体。
- [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-credits-index)：接受的部署字段。
- [余额与用量](../../client/ui-credits/README.zh.md)：面向账号的面板。
- [创作内容](../../client/creation-content/README.zh.md)：已发布内容的校验。

<a id="model-experience"></a>
## 模型体验

### 使用量分析

#### 模型接收的内容

通过 `/credits/api/usage` 进行的使用量分析仅供浏览器读取，不贡献模型输入。

#### token 影响

使用量读取不请求模型，也不消耗模型 token。

#### KV Cache 影响

使用量分析不改变模型上下文或 KV 缓存。

### 提示词帮写

#### 模型接收的内容

提示词帮写发起一次不流式返回的聊天生成；系统指令及用户文本将原稿、修改意见、参数和图片视为不可信参考资料。模型返回纯文本候选提示词。每次修改都发送当前编辑后的候选及新意见，而不是隐式对话历史。模型可见输入及经过校验的结果，可通过上述私有独立记录重建。

#### token 影响

每次帮写或修改请求均按当前账号计费，生成输出上限为 2,048 tokens。原稿文字、修改意见、参数及参考图片均贡献输入用量。

#### KV Cache 影响

每次明确发起的请求都提供当前原稿和修改意见，不包含隐式对话历史。这个独立流程不管理提供方缓存。

### 视频项目与剪辑

#### 模型接收的内容

视频工具（包括 `generate_video_project`）向模型上下文加入分镜规划、本地剪辑、持久状态和显式恢复说明。分镜说明来自已记录的工具输入和保存的有序说明。现有任务工具通过常规日志结果呈现进度和最终路径。视频项目记录保留完整生成请求，无需改变会话格式或代理循环。

#### token 影响

工具声明与已记录结果贡献常规代理上下文 token。工具不会额外调用聊天生成；计费的视频模型调用遵循已持久化的片段计划。

#### KV Cache 影响

工具声明与已记录结果遵循常规 Session 请求处理。视频生成和本地剪辑不添加隐式聊天历史，也不管理提供方缓存。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 数据源按小时分组，通常每五分钟写入一次。这些汇总无法提供准确请求时刻、扣除退款的净支出、输入输出 token 拆分或实时余额账本。用量响应最多包含 100,000 条源记录；超限时明确报错。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
