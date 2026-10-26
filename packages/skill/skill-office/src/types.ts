/** Structured authoring configuration independent of tool schemas. */
export interface OfficeCreationConfig {
  /** Enable structured creation, inspection, and safe patch tools. */
  readonly enabled: boolean
  /** Bundled Python payload. */
  readonly source: string
  /** Optional dependency installation root. */
  readonly root?: string
  /** Whole authoring command deadline, subject to the shell's existing cap. */
  readonly timeoutMs: number
  /** Maximum structured content bytes. */
  readonly maxInputBytes: number
  /** Maximum total array entries across one request. */
  readonly maxItems: number
  /** Maximum worksheet cells touched, including number-format ranges. */
  readonly maxCells: number
  /** Maximum source file bytes for inspection and SHA-bound editing. */
  readonly maxFileBytes: number
  /** Maximum ZIP members in a source Office file. */
  readonly maxArchiveEntries: number
  /** Maximum declared expanded ZIP bytes. */
  readonly maxUncompressedBytes: number
  /** Maximum objects returned by an inspection. */
  readonly maxInspectItems: number
  /** Maximum text characters per inspected object preview. */
  readonly maxPreviewChars: number
  /** Maximum complete stdout result bytes. */
  readonly maxOutputBytes: number
}
