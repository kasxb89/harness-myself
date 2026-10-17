# 产出物

[English](deliverables.md) | 中文

记录一轮交给用户的东西，由 [deliverables 包组](../../packages/deliverables/README.zh.md)拥有：模型通过 `present` 工具声明的文件，记在一个只写日志的 Session 事件里；这一轮改动的文件，由轮开始和轮结束时的 git 工作树快照对比得出，git 覆盖不到的路径则由文件工具每次编辑前后的整文件捕获得出，用一个只写日志的事件宣告，并在 Session 存活期间由 Host 服务连同每个所列文件在轮开始与轮结束时的对比一起提供。它们只由客户端读取，Web [产出物插件](../../packages/client/ui-deliverables/README.zh.md)在轮末渲染两者。工具行为、快照机制和配置见 [`tool-present`](../../packages/deliverables/tool-present/README.zh.md) 与 [`workspace-changes`](../../packages/deliverables/workspace-changes/README.zh.md) 的包 README。

源码：[`packages/deliverables/tool-present/src/types.ts`](../../packages/deliverables/tool-present/src/types.ts)、[`packages/deliverables/workspace-changes/src/types.ts`](../../packages/deliverables/workspace-changes/src/types.ts)

## `PresentedFile`：一条声明的交付

```ts type-equiv
/** A declared filesystem file whose current contents remain at its source path. */
interface PresentedFile {
  /** Original absolute path or path relative to the Session working directory. */
  path: string
  /** Optional description supplied by the model. */
  description?: string
}
```

## `WorkspaceChangedFile`：一个改动的文件

```ts type-equiv
/** One file changed during a turn, with line counts from git or from the whole-file captures around its file-tool edits. */
interface WorkspaceChangedFile {
  /** Path relative to the Session working directory, or an absolute Host path outside it. */
  path: string
  /**
   * Sort key and label: the relative path inside the working directory, a
   * `../` path for repository files above it, a `~` path under the home
   * directory, otherwise the absolute path. Always slash-separated.
   */
  display: string
  /** Lines added; zero for a binary or oversized file. */
  added: number
  /** Lines deleted; zero for a binary or oversized file. */
  deleted: number
  /** Present when git reported the file as binary, or when a captured side holds a NUL byte. */
  binary?: true
  /** Present when a captured side exceeded the plugin's `maxFileBytes`; the file is listed without counts or comparison. */
  oversized?: true
}
```

## `WorkspaceChangesSummary`：一轮的改动摘要

```ts type-equiv
/**
 * Files changed during one top-level turn: kept while its Session is observed,
 * and stored when the composition mounts storage so the card outlives it.
 */
interface WorkspaceChangesSummary {
  /** The turn whose file changes this summary describes. */
  turn: number
  /** The Session working directory `path` values are relative to. */
  cwd: string
  /** Changed files in `display` order, capped at the plugin's `maxFiles`. */
  files: WorkspaceChangedFile[]
  /** Complete changed-file count, including files omitted by the cap. */
  total: number
  /** Lines added over every changed file, including files omitted by the cap. */
  added: number
  /** Lines deleted over every changed file, including files omitted by the cap. */
  deleted: number
  /** Git tree ids of the turn-start and turn-end snapshots; absent when no snapshot was taken. */
  snapshot?: { before: string; after: string }
}
```

## `WorkspaceDiffHunk`：一个 unified diff hunk

```ts type-equiv
/** One unified-diff hunk with three context lines; every line keeps its `+`, `-`, or space prefix. */
interface WorkspaceDiffHunk {
  /** First line of the hunk in the turn-start content, 1-based; a side without lines starts at 1 with zero lines. */
  oldStart: number
  /** Lines of the hunk taken from the turn-start content. */
  oldLines: number
  /** First line of the hunk in the turn-end content, 1-based; a side without lines starts at 1 with zero lines. */
  newStart: number
  /** Lines of the hunk taken from the turn-end content. */
  newLines: number
  /** Hunk body in order, each line prefixed with `+`, `-`, or a space. */
  lines: string[]
}
```

## `WorkspaceFileDiff`：一个文件的对比

```ts type-equiv
/** The comparison of one listed file's turn-start and turn-end contents, computed when asked for. */
type WorkspaceFileDiff =
  | {
    kind: 'text'
    /** The listed file's `path`. */
    path: string
    /** The listed file's `display`. */
    display: string
    /** Whether the file existed at turn start. */
    before: boolean
    /** Whether the file existed at turn end. */
    after: boolean
    /** Hunks in file order; empty when both sides hold the same lines. */
    hunks: WorkspaceDiffHunk[]
    /** True when the line comparison exceeded the plugin's `diffTimeoutMs` and every line is shown as replaced. */
    coarse: boolean
  }
  /** A side git reported as binary or that holds a NUL byte; no lines are served. */
  | { kind: 'binary'; path: string; display: string }
  /** A side larger than the plugin's `maxFileBytes`; no lines are served. */
  | { kind: 'oversized'; path: string; display: string }
```

## `WorkspaceChanges`：提供摘要与对比的 Host 服务

```ts type-equiv
/**
 * Serves the summaries the recorder keeps for live Sessions and the ones it
 * recorded earlier from storage, plus the comparisons of live Sessions.
 */
interface WorkspaceChanges {
  /**
   * The summary announced by one `workspace/changes` event.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @returns the summary, or undefined when this Host never recorded the event and nothing is stored for it.
   */
  summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined
  /**
   * Compare one listed file's contents at turn start and turn end.
   * @param sessionId - the Session that appended the event.
   * @param seq - the event's sequence number.
   * @param index - the file's index in the summary's `files`.
   * @param signal - cancels the reads.
   * @returns the comparison, or undefined once its Session was disposed, when this Host never recorded it, or when no file has that index.
   * @throws when a snapshot read fails for a live Session.
   */
  diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>
}
```

## 产物输出管理

可选的 `ctx.artifactStorage` 服务是由 [artifacts-index](../../packages/deliverables/artifacts-index/README.zh.md) 声明、仅供可信 Host 使用的能力。[`ArtifactDestination`、`ArtifactWriteRequest`、`ArtifactPublishRequest`、`ArtifactWriteResult` 与 `ArtifactStorageInfo`](../../packages/deliverables/artifacts-index/src/types.ts) 契约描述已捕获的目标、独占输出与持久浏览根目录。生成方在计费前捕获可写目标，随后写入字节或复制成片，不替换已有文件。该服务不改变会话工作区、不添加模型工具，也不追加 Session 事件。文件管理与恢复由同包经过认证的浏览器路由负责。

浏览器区分已保存输出的产物库与已注册工作区文件。工作区访问按实时注册表校验，不向输出偏好添加根目录；目录列表描述当前文件，不判断由哪个 Session 生成。导航、授权与可恢复文件操作由 [artifacts-index 契约](../../packages/deliverables/artifacts-index/README.zh.md)定义。

## 持久事件与提供的摘要

`tool-present` 通过声明合并把 `deliverables/presented: { turn; callId; files: PresentedFile[] }` 加入 `SessionEventMap`，每次 `present` 的最终结果成功时追加一条。`workspace-changes` 合并 `workspace/changes: { turn }`，在顶层轮停止时追加。摘要本身不在日志里：Session 被观察时由记录器保留，组合装配存储时还写入 `workspace_changes` 域。`workspaceChanges.summary(sessionId, seq)` 按事件序号读取实时或已存储的摘要，因此有存储时，改动文件卡片可以在 Session 释放或 Host 重启后保留。`workspaceChanges.diff(sessionId, seq, index, signal)` 只为实时 Session 对比所列文件。同一轮后来的事件替代先前的，客户端只保留最新一条。生成的[持久化目录](../persistence-catalog.zh.md#deliverablespresented--log-only)记录了两处声明位置。两个事件都不会进入模型请求。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxartifactstorage--artifactstorageservice"></a>

### `ctx.artifactStorage` — `ArtifactStorageService`

Optional shared output capability consumed by account media generators.

```ts cordis-catalog
/**
 * Validate writability and retain this exact directory for an in-flight operation.
 * @param signal - Caller lifetime while checking local output availability.
 * @returns The currently selected canonical output directory.
 */
capture(signal: AbortSignal): Promise<ArtifactDestination>

/**
 * Check a retained destination again before resuming any further paid work.
 * @param destination - Original approved directory from the durable operation.
 * @param signal - Caller lifetime while checking local output availability.
 * @returns Resolves only when the original directory remains approved and writable.
 */
validate(destination: ArtifactDestination, signal: AbortSignal): Promise<void>

/**
 * Create an exclusive output; never replace an existing user file.
 * @param request - Captured destination, portable filename, bytes and caller lifetime.
 * @returns The complete exclusively published output path.
 */
write(request: ArtifactWriteRequest): Promise<ArtifactWriteResult>

/**
 * Copy a finished file without replacing a destination or removing its source.
 * @param request - Captured destination, finished source, portable filename and caller lifetime.
 * @returns The complete exclusively published copy path.
 */
publish(request: ArtifactPublishRequest): Promise<ArtifactWriteResult>
```

Source: [`packages/deliverables/artifacts-index/src/types.ts`](../../packages/deliverables/artifacts-index/src/types.ts)

<a id="ctxworkspacechanges--workspacechanges"></a>

### `ctx.workspaceChanges` — `WorkspaceChanges`

Serves the summaries the recorder keeps for live Sessions and the ones it recorded earlier from storage, plus the comparisons of live Sessions.

```ts cordis-catalog
/**
 * The summary announced by one `workspace/changes` event.
 * @param sessionId - the Session that appended the event.
 * @param seq - the event's sequence number.
 * @returns the summary, or undefined when this Host never recorded the event and nothing is stored for it.
 */
summary(sessionId: SessionId, seq: number): WorkspaceChangesSummary | undefined

/**
 * Compare one listed file's contents at turn start and turn end.
 * @param sessionId - the Session that appended the event.
 * @param seq - the event's sequence number.
 * @param index - the file's index in the summary's `files`.
 * @param signal - cancels the reads.
 * @returns the comparison, or undefined once its Session was disposed, when this Host never recorded it, or when no file has that index.
 * @throws when a snapshot read fails for a live Session.
 */
diff(sessionId: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined>
```

Types: [SessionId](core.zh.md)

Source: [`packages/deliverables/workspace-changes/src/types.ts`](../../packages/deliverables/workspace-changes/src/types.ts)
<!-- END GENERATED cordis-surface -->
