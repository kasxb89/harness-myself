---
description: "随包附带的 Word、PowerPoint 和 Excel 指令，供需要 Office 文件编写与结构检查能力的部署使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-office

[English](README.md) | 中文

## 概述

Agent（智能体）可以加载 Word、PowerPoint 和 Excel 工作流，默认使用内置 Python 环境，并遵循用户或 AGENTS.md 明确指定的环境。这些 skill（技能）涵盖创建、局部编辑、结构检查和文件交付。环境提供 LibreOffice Kit CLI 时，可直接渲染选定页面或工作表区域、转换所需 PDF，并将重新计算后的工作簿保存为新文件。视觉检查要求模型支持图片输入，复用源文件未变时的预览，并在适用检查通过后结束；普通交付不要求安装渲染器。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本提供方与 skill 注册表及 `dsh-tool-skill` 一同挂载，即可在会话目录中提供 `office-docx`、`office-pptx` 和 `office-xlsx`。提供方携带指令和脚本；部署提供解释器、编写库、执行工具与文件交付工具。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-skill-office'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `assetRoot` | 包内的 `assets/` | 包含三个 skill 文件夹和共享 `scripts/` 的绝对资源目录；部署可将其放在应用归档之外。 |
| `node` | 当前独立 Node 进程 | Node 可执行文件的绝对路径；Electron 和独立 SDK 可执行文件必须显式提供。 |
| `cli` | 已安装 kit 的 `lib/cli.js` | CLI 入口的绝对路径；`false` 显式禁用 CLI。 |
| `renderApi` | 包内 `lib/render-cache.js` | 应用归档外独立模块的绝对路径；Desktop 和 SDK 将其复制到固定脚本旁。 |

相对路径、资源缺失或 skill 文件的 YAML frontmatter 缺少描述都会导致激活失败。卸载插件会移除其候选项。项目和用户 skill 的优先级仍由 skill 注册表负责。

加载的技能在 `Installed LibreOffice Kit` 段落中提供 `libreofficeKit.node` 和 `libreofficeKit.cli` 的绝对路径。除非用户明确要求不用内置二进制，Agent 将内置 CLI 作为 Node 的第一个参数运行，无需依赖工作目录或搜索 PATH。内置 CLI 失败时报告错误，不替换为系统可执行文件。激活时检查两个路径是否为实际文件。npm 部署默认使用已安装的 kit；Desktop 提供独立 Node 和 ASAR 外的完整 Office 依赖；Python SDK 提供独立 Node 和可执行文件旁的 Office 目录。Electron／SEA 打包部署还必须显式提供应用归档外的独立 `renderApi`。仅有 Python 的自定义部署必须配置 `cli: false`，或提供独立运行时路径。

已安装运行环境还提供 `libreofficeKit.renderWrapper` 和 `libreofficeKit.renderApi`。使用 Node 调用此固定脚本，传入 `--api <渲染接口绝对路径>` 和 `--cli <Kit CLI 绝对路径>`、`--input`、新的 `--output-dir`，以及完整的 `--pages` 页码选择或工作表 `--sheet`/`--range`；脚本对整批只调用一次公共 Kit `renderImages`，随后释放引擎。可选的 `--cache-dir`、`--cache-ttl-ms`、`--cache-max-bytes` 和 `--font-inventory` 控制磁盘复用及其预算。复用键包含已保存文件的 SHA256、页码或范围与渲染设置、引擎版本及内容身份、每次重新验证的完整字体库存。可信库存需声明 `schemaVersion: 1`、当前 `platform`、`complete: true`、绝对路径 `roots` 和 `files: [{path, sha256}]`；目录成员与每个字体的摘要必须匹配。库存缺失或无法验证时仍正常批量渲染，只是不复用结果。缓存损坏或存储不可用不代表预览通过，也不更改源文件。输出独占创建，只在整批完成后发布清单；取消会等待引擎清理。`--invalidate-cache --cache-dir <私有目录>` 推进缓存代际，不改变源文档或已经交付的输出。调用之间不保留运行中的引擎。

### 结构化创建

Desktop 传入 `creation: { source, root, enabled: true }` 后提供 `word_create`、`slides_create`、`workbook_create`、`office_inspect` 和 `office_patch`。工具通过原有会话工作目录、权限策略和 shell 执行通道调用内置 Python，不需模型编写代码或安装依赖。新文件使用语义标题和完整 UUID，结构检查完成后才发布，不能覆盖已有文件。创建支持原生可编辑 Word 块、PowerPoint 文字／表格／图表／备注，以及 Excel 类型化数据／样式／公式。复杂排版、模板、高级修改、新工作簿图表和大型本地数据仍走可编程技能流程。

存在 creation 段时 `creation.enabled` 默认 true；未配置则不启用。`source` 必填，`root` 可选。可调默认值为 `timeoutMs: 120000`、`maxInputBytes: 2097152`、`maxItems: 1000000`、`maxCells: 1000000`、`maxOutputBytes: 131072`；仍受原 shell 时限上限约束。显式 Excel 公式通过内置 CLI 真正重算整个工作簿，并检查公式保留和非空、非错误缓存结果。数据中的等号开头字符串保持文本。重算失败不能声称已有计算值。

成功结果包含绝对路径、格式、结构摘要、重算标记、视觉检查要求和本地编写耗时。Word 与 PowerPoint 仍按技能完成适用的排版检查，结构化创建不能证明外观。相关检查通过后使用 present 交付；运行时和子进程失败属于本地执行错误，不归为服务器错误。固定 Python 入口以 UTF-8 读取 JSON 输入并输出结果／错误，不依赖系统区域或继承的 Python 管道编码，内容与路径中的中文和表情均保持原样。公式重算时，引擎未使用的输出保持为字节，避免子进程的 ANSI 区域编码误读 UTF-8 结果路径。

`office_inspect` 返回源文件的精确 SHA256、有界文字／对象／单元格摘要和兼容警告。`office_patch` 在修改前后检查该 SHA；替换唯一匹配的 Word 段落／run 或 PowerPoint 形状／备注文字并保留 run 属性，或修改指定 Excel 单元格／数字格式。仅重写受影响 XML 部件，无关图表、图片、嵌入数据和样式部件保持原字节。影响公式的工作簿修改会真正重算，仅把计算缓存合回保留的原包，并报告已有公式错误；数组与共享公式会刷新全部结果单元格缓存，同时保留原公式和模板对象；传统 CSE 数组范围保持固定。仅明确的 XLDAPR 动态数组元数据会启用真实引擎 ROWS／COLUMNS 尺寸检查，在计算前后核对范围；扩张不能覆盖已有用户单元格，收缩只清除原派生范围。尺寸无法确认或动态依赖不稳定时停止发布，要求用 Excel 重算未改动的源文件。检查共享命令时限与单元格预算，普通和固定数组修改不增加尺寸探测。新增公式提供预期值时需精确验证。修改值／公式时移除过期计算链。含宏、外链、主动内容或不支持的高级特征时转可编程保全流程；被动 custom XML 保留且不单独阻止编辑。原文件不变，SHA 过期需要重新检查。

检查／修改默认配置为 `maxFileBytes: 52428800`、`maxArchiveEntries: 10000`、`maxUncompressedBytes: 262144000`、`maxInspectItems: 200`、`maxPreviewChars: 1000`，均位于同一 creation Config。摘要截断会明确标记，仍检查档案、原文件及完整输出预算。这些定点操作不支持任意 OOXML 特性修改，也不保证与 Microsoft Office 像素一致。

### 结构检查

共享 Python 检查器读取 DOCX、PPTX 或 XLSX，不修改源文件。它识别 Transitional 与 Strict OOXML 命名空间，验证 ZIP/XML 和包内引用关系，报告文档结构，并可检查必需文本或幻灯片／工作表数量。DOCX 文本断言覆盖正文、分节引用的页眉和页脚，以及正文引用的脚注和尾注；批注、词库文本与未引用的部件或脚注／尾注不能满足断言。它只使用 Python 标准库。无效包、损坏或加密的 ZIP 成员和报告文件写入失败都会在标准输出中产生 JSON 失败报告。检查通过不代表外观、特性保留或公式计算结果已得到验证。

Excel 数据和公式任务跳过视觉检查；涉及格式、排版、图表外观、打印或已知显示问题时，检查相关区域。基础样式设置本身不触发视觉检查，公式重算和用户要求的导出仍是独立操作。 空白或透明预览不能通过视觉检查。预览失败时结束视觉检查，不创建诊断工作簿、不转换 PDF，也不擅自修改打印设置；交付可用工作簿并说明检查限制。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

提供方注册三个内置候选项，并在激活时从随包 YAML frontmatter 读取描述。加载后的指令正文不包含这些元数据。加载后的每个 skill 暴露自己的文件系统目录，因此执行工具可以定位共享检查器，而不依赖任务工作目录。可配置的外部资源支持 Python 无法读取应用归档的分发方式。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方注册与配置资源路径。 |
| [`assets/`](assets/) | 三种工作流和只读 OOXML 检查器。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [skill 注册表](../skill/README.zh.md)——发现与优先级。
- [skill 工具](../tool-skill/README.zh.md)——模型可见目录与正文。
- [文件交付](../../deliverables/tool-present/README.zh.md)——当前源路径交付。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-skill` 间接呈现，由其渲染目录项与选中的指令正文。

#### KV 缓存影响

挂载提供方会增加三个目录项；加载 skill 时，其正文进入既有 skill 工具的插入位置。提供方不另增提示词分区。启用结构化编写会增加五个稳定的具名 JSON 工具 schema 和紧凑结果，普通创建避免生成编写脚本及中间 shell 调用。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 提供方依赖 LibreOffice Kit，但不安装 Python 或编写库。检查器要求 Python 3.9 或更高版本。
- 结构检查不判断分页、裁切、字体、图表外观或 Excel 重算。
- 检查器只接受 DOCX、PPTX 和 XLSX；传统格式、加密文件和启用宏的格式需要合适的其他工作流。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
