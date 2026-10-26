---
description: "load_workspace_dependencies 工具：返回随包附带的 Python、Node.js 与 pnpm 的绝对路径，payload 可原地使用或安装到 Harness home。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workspace-dependencies

[English](README.md) | 中文

## 概述

自带脚本运行时的部署（Desktop 的 primary runtime，或容器镜像层）挂载本工具，让 agent 询问随包的 Python、Node.js 与 pnpm 在哪里，而不是自行寻找系统解释器。工具返回绝对路径与记录的发行版版本，不改 `PATH`，不改包管理器设置。payload 或在首次调用时复制到 Harness home 下（Desktop），或原地使用（只读载体）。

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

与工具注册表一起挂载，给出 payload 目录。配置校验在激活前要求非空 `source` 并拒绝空 `root`；两条路径都必须为绝对路径。内置 Office skills（`@deepseek-ai/dsh-skill-office`）按名字引用本工具取默认解释器。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-tool-workspace-dependencies'
  config:
    source: /path/to/primary-runtime
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `source` | 必填 | 含 `runtime.json` 与 `dependencies/` 的 payload 绝对目录。 |
| `root` | 未设置 | Harness home 下的绝对安装目录。设置时在旁侧 `<root>.payloads/` 安装稳定依赖代，锁定依赖相同则跨载体版本复用；无 digest 的旧清单保留固定目录。未设置时校验后原地使用。 |
| `lockWaitMs` | `30000` | 等待其它安装者的最长时间，不使其所有权过期。 |
| `lockPollMs` | `100` | 等待安装所有权时的检查间隔。 |

带 digest 的代身份包含平台、架构、payload digest、解释器与包管理器版本，以及排序后的官方 Python 分发版本。`desktopVersion` 记录载体，不使相同依赖失效。每个 Host 首次准备均检查载体和已安装解释器／库入口；缺失或格式错误的本地入口通过暂存和原子发布修复。这是入口验证，不是全部安装文件的实时哈希审计。旧代和前代目录保留供运行中的应用使用，不自动清理。原子发布的私有 PID 所有权目录协调多个 Host；只有确认原进程不存在才回收，不能按时间取走仍存活进程的锁。若回收进程自身在移走旧锁前退出，会报告中断回收并要求检查，避免删除未经确认的新活锁。

### payload 布局

`runtime.json` 记录 `desktopVersion`、`platform`（`win32`、`darwin` 或 `linux`）、`arch`、可选的 `payloadDigest`、顶层 `python` 与可选的 `node`/`pnpm` 版本，以及完整的 `pythonPackages` 分发包版本表。声明 pnpm 时必须同时声明 Node.js。numpy、pandas 等 Python 库只出现在 `pythonPackages` 中。条目位于 `dependencies/`：`python/bin/python3`（Windows 为 `python/python.exe`）及其下的 `site-packages`；声明了才有的 `node/bin/node`、`node/node_modules` 与 `pnpm/bin/pnpm.mjs`。平台或架构与当前进程不符的清单被拒绝。

打包的 `sdk` profile 默认使用随包 Python 和 Office skills；`DSH_PRIMARY_RUNTIME` 覆盖资源位置，空值表示禁用。没有载体默认路径的源码启动仍需显式启用。独立选择 skills 的方式见[运行时配置](../../../python/sdk-runtime/README.zh.md)。缺少 skill 资源会产生启动警告；无效或不完整的外部运行时 payload 在首次工具调用时失败。profile 配置变更需要重启 SDK 进程。

### 构建载体 payload

在已安装依赖的仓库 checkout 中运行 `CI=true pnpm run prepare:primary-runtime --target linux-x64 --output /tmp/dsh-office`，会生成 `primary-runtime/` 和 `office-skills/`。[共享下载锁](../../../scripts/primary-runtime/lock.json)还覆盖 `linux-arm64`、`mac-arm64`、`mac-x64` 和 `win-x64`。`--python-only` 省略 Node.js 和 pnpm；`--cache` 选择经过哈希校验的归档缓存。入口仅对本机目标执行解释器与 Office 读写检查。跨目标构建必须在部署前到目标主机执行这些检查。

容器可将这两个目录复制到不可变镜像层，并将 `DSH_PRIMARY_RUNTIME` 设为 `primary-runtime/` 的绝对路径。SDK 原位查询该 payload。Desktop 使用同一构建器，并保留 Harness-home 安装与签名检查。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

`readPrimaryRuntime` 与构建冒烟检查共用 `parsePrimaryRuntime`。它校验扁平清单，拒绝归一化后重名的分发包。旧 `components` 元数据在内存中归一化，并保留旧格式的一致性校验；旧分发包版本表缺失时转换为空表。混用顶层与旧组件版本字段会被拒绝。读取不改写元数据，归一化后等价的清单可复用已安装产物。`workspaceDependencyPaths` 推导各平台的条目路径。`installPrimaryRuntime` 复制到暂存目录、要求声明的解释器和脚本为文件、库路径为目录、再原子发布并保留旧树；`resolvePrimaryRuntime` 做同样的校验但不复制。工具在插件生命周期内记住首次成功的结果。

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 清单校验、路径推导、原地与安装两种准备方式、工具注册。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Office skills](../skill-office/README.zh.md)——调用本工具取解释器的工作流。
- [工具注册表](../../core/tools/README.zh.md)——注册与 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`load_workspace_dependencies` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-workspace-dependencies)。

#### Token 影响

工具可见的每个请求固定一份 schema 开销；描述里列出了随包的 Office 库，模型不必先加载 skill 就能选择解释器。

#### KV 缓存影响

工具定义与可见性不变时前缀稳定。

### 工具结果

#### 模型看到什么

一个 JSON 对象：绝对路径 `python` 与 `pythonPackages`、来自 `runtime.json` 的 `pythonDistributions`，以及 payload 声明了才有的 `node`、`nodePackages` 与 `pnpm`。重复调用返回同一对象。

#### Token 影响

每次调用几百个字符，以路径为主。

#### KV 缓存影响

作为工具结果追加进轮次历史；不增加提示词分区。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 回收进程若在移走已退出安装者的锁之前死亡，工具会报告中断回收并保留锁待检查。该极端中断不自动修复；它属于本地工具失败，不终止客户端。
- Linux 目标需要 glibc；尚未锁定 musl payload。
- Windows 上原地使用的 payload 须在载体里已可执行；原地模式不修复权限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

</details>
