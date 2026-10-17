# Deliverables

English | [中文](deliverables.zh.md)

What a turn hands to the user, owned by the [deliverables package group](../../packages/deliverables/README.md): the files the model declared through the `present` tool, recorded in a log-only Session event, and the files the turn changed, summarized from git working-tree snapshots taken at turn start and turn end plus whole-file captures around each file-tool edit for the paths git does not cover, announced by a log-only event and served by a Host service while the Session lives together with each listed file's turn-start and turn-end comparison. Only clients read them; the Web [deliverables plugin](../../packages/client/ui-deliverables/README.md) renders both at the end of the turn. Tool behavior, snapshot mechanics, and configuration are on the package READMEs for [`tool-present`](../../packages/deliverables/tool-present/README.md) and [`workspace-changes`](../../packages/deliverables/workspace-changes/README.md).

Sources: [`packages/deliverables/tool-present/src/types.ts`](../../packages/deliverables/tool-present/src/types.ts), [`packages/deliverables/workspace-changes/src/types.ts`](../../packages/deliverables/workspace-changes/src/types.ts)

## `PresentedFile` — one declared delivery

```ts type-equiv
/** A declared filesystem file whose current contents remain at its source path. */
interface PresentedFile {
  /** Original absolute path or path relative to the Session working directory. */
  path: string
  /** Optional description supplied by the model. */
  description?: string
}
```

## `WorkspaceChangedFile` — one changed file

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

## `WorkspaceChangesSummary` — one turn's change summary

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

## `WorkspaceDiffHunk` — one unified-diff hunk

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

## `WorkspaceFileDiff` — one file's comparison

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

## `WorkspaceChanges` — the Host service serving summaries and comparisons

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

## Managed artifact output

The optional `ctx.artifactStorage` service is a trusted Host capability declared by [artifacts-index](../../packages/deliverables/artifacts-index/README.md). Its [`ArtifactDestination`, `ArtifactWriteRequest`, `ArtifactPublishRequest`, `ArtifactWriteResult` and `ArtifactStorageInfo`](../../packages/deliverables/artifacts-index/src/types.ts) contracts describe captured destinations, exclusive output and persistent browsing roots. Producers capture a writable destination before paid work, then write bytes or copy a finished file without replacing existing files. The service does not change the conversation workspace, add model tools or append Session events. File management and recovery use authenticated browser routes owned by the same package.

The browser distinguishes the saved-output library from registered workspace files. Workspace access is checked against the live registry and does not add roots to output preferences; its directory listing describes current files, not which Session generated them. The owning [artifacts-index contract](../../packages/deliverables/artifacts-index/README.md) defines navigation, authorization and reversible file operations.

## Durable events and the served summary

`tool-present` declaration-merges `deliverables/presented: { turn; callId; files: PresentedFile[] }` into `SessionEventMap`, appended once per successful final `present` result. `workspace-changes` merges `workspace/changes: { turn }`, appended when a top-level turn stops. The summary is not in the log: the recorder keeps it while its Session is observed and also writes it to the `workspace_changes` domain when the composition mounts storage. `workspaceChanges.summary(sessionId, seq)` serves live or stored summaries for the event's sequence, so stored changed-files cards can outlive Session disposal and Host restarts. `workspaceChanges.diff(sessionId, seq, index, signal)` compares listed files only for live Sessions. A later event for the same turn replaces the earlier one, so a client keeps only the latest. The generated [persistence catalog](../persistence-catalog.md#deliverablespresented--log-only) records both declaration sites. Neither event reaches the model.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [SessionId](core.md)

Source: [`packages/deliverables/workspace-changes/src/types.ts`](../../packages/deliverables/workspace-changes/src/types.ts)
<!-- END GENERATED cordis-surface -->
