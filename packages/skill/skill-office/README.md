---
description: "Bundled Word, PowerPoint, and Excel instructions for deployments providing Office file authoring and structural checks."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-office

English | [中文](README.zh.md)

## Summary

Agents can load Word, PowerPoint, and Excel workflows that use the bundled Python environment by default and respect explicit user or AGENTS.md environment choices. The skills cover creation, focused edits, structural checks, and file delivery. When supplied by the environment, the LibreOffice Kit CLI directly renders selected pages or worksheet ranges, converts requested PDFs, and recalculates workbooks into new files. Visual QA requires image input support, reuses unchanged-source previews, and ends when applicable checks pass; ordinary delivery does not require installing a renderer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider beside the skill registry and `dsh-tool-skill` to expose `office-docx`, `office-pptx`, and `office-xlsx` in the session catalog. The provider supplies instructions and scripts; the deployment supplies its interpreters, authoring libraries, execution tools, and file delivery tool.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-skill-office'
```

| Field | Default | Meaning |
|---|---|---|
| `assetRoot` | Packaged `assets/` | Absolute resource directory containing the three skill folders and shared `scripts/`; deployments can place it outside an application archive. |
| `node` | Current standalone Node process | Absolute Node executable; Electron and SDK executables must supply a standalone Node. |
| `cli` | Installed kit’s `lib/cli.js` | Absolute CLI entry; `false` explicitly disables the CLI. |
| `renderApi` | Packaged `lib/render-cache.js` | Absolute standalone module outside application archives; Desktop and SDK copy it next to the fixed scripts. |

Relative paths, missing resources, and skill files without a YAML frontmatter description reject activation. Disposing the plugin removes its candidates. Project and user skill precedence remains owned by the skill registry.

Loaded skills append an `Installed LibreOffice Kit` section with absolute `libreofficeKit.node` and `libreofficeKit.cli` paths. Agents use the bundled binaries unless the user explicitly opts out, passing the CLI as Node’s first argument without relying on the working directory or searching PATH. A bundled CLI failure is reported rather than replaced with a system executable. Activation checks both paths are files. npm deployments use their installed kit by default; Desktop supplies standalone Node and the complete unpacked Office dependencies; the Python SDK supplies standalone Node and its adjacent Office directory. Packaged Electron/SEA deployments also supply an explicit standalone `renderApi` outside application archives. Custom Python-only deployments must set `cli: false` or supply the standalone runtime paths.

The installed runtime also supplies `libreofficeKit.renderWrapper` and `libreofficeKit.renderApi`. Invoke that fixed Node script with `--api <absolute-render-api>` and `--cli <absolute-kit-cli>`, `--input`, a new `--output-dir`, and the whole `--pages` selection or worksheet `--sheet`/`--range`; it calls the public Kit `renderImages` once for the batch and disposes the engine. Optional `--cache-dir`, `--cache-ttl-ms`, `--cache-max-bytes`, and `--font-inventory` configure bounded disk reuse. Reuse keys include saved-file SHA256, selected pages/range and rendering options, engine version/content identity, and a freshly verified complete font inventory. The trusted inventory declares `schemaVersion: 1`, the current `platform`, `complete: true`, absolute `roots`, and `files: [{path, sha256}]`; directory membership and every font digest must match. Missing or unverifiable inventory still renders normally without reuse. Cache corruption or storage unavailability does not certify a preview or change the source. Output files are exclusive, manifests publish only complete batches, and cancellation joins engine cleanup. `--invalidate-cache --cache-dir <private-directory>` advances the cache generation without changing source documents or delivered outputs. No engine remains running between calls.

### Structured creation

Desktop supplies `creation: { source, root, enabled: true }` to expose `word_create`, `slides_create`, `workbook_create`, `office_inspect`, and `office_patch`. They use the ordinary session working directory, permission policy, and shell execution seam with bundled Python; no model-written code or package installation is needed. New files use a semantic title and complete UUID, publish only after structural checks, and never overwrite existing files. Creation supports native editable Word blocks, PowerPoint text/tables/charts/notes, and Excel typed data/styles/formulas. Complex layouts, templates, advanced edits, charts in new workbooks, and large local datasets retain the programmable skill workflow.

`creation.enabled` defaults to true when the section exists; no section leaves tools disabled. `source` is required and `root` optional. Configurable defaults are `timeoutMs: 120000`, `maxInputBytes: 2097152`, `maxItems: 1000000`, `maxCells: 1000000`, and `maxOutputBytes: 131072`; the existing shell deadline cap still applies. Excel formula entries use the bundled CLI for genuine whole-workbook recalculation and check formula preservation and available/error-free cached results. Formula-free data strings beginning with `=` remain text. A failed recalculation does not claim calculated results.

A successful result contains the absolute path, format, structural summary, recalculation flag, visual-check requirement, and local authoring duration. Word and PowerPoint still require applicable visual layout checks through the skill; structural creation does not certify appearance. The tool result can be delivered using `present` once the relevant checks pass. Runtime and child failures remain local execution errors, not server errors. Fixed Python entrypoints read JSON input and write results/errors as UTF-8 independently of the system locale or inherited Python pipe encoding, including Chinese and emoji in content and paths. Formula recalculation captures the engine's unused output as bytes so an ANSI subprocess locale cannot misdecode UTF-8 result paths.

`office_inspect` returns the exact source SHA256, bounded text/object/cell summaries, and compatibility warnings. `office_patch` requires that SHA before and after editing, replaces one matching Word paragraph/run or PowerPoint shape/notes text while retaining run properties, and changes explicit Excel cells or number formats. It rewrites only affected XML parts; unrelated chart, image, embedding, and style parts retain their original bytes. Formula-affecting workbook edits genuinely recalculate, merge only calculated caches into the preserved package, and report existing formula errors. Array and shared-formula caches include every result cell while preserving original formulas and template objects. Traditional CSE array ranges remain fixed. Explicit XLDAPR dynamic-array metadata enables real-engine ROWS/COLUMNS size checks before and after calculation; resizing cannot overwrite existing user cells, and shrinking clears only the former derived range. Unconfirmed sizes or unstable dynamic dependencies stop publication and require Excel recalculation of the unchanged source. These checks share the command deadline and cell budget; ordinary and fixed-array edits need no size probes. Newly entered formulas are checked against an explicit expected value when provided. A stale calculation chain is removed when values/formulas change. Macro-enabled, external, active, or unsupported advanced content requires the programmable preservation workflow; passive custom XML is preserved and does not itself block an edit. Original files are never changed, and a stale SHA requires inspection again.

Inspection/edit defaults are `maxFileBytes: 52428800`, `maxArchiveEntries: 10000`, `maxUncompressedBytes: 262144000`, `maxInspectItems: 200`, and `maxPreviewChars: 1000`, all in the same creation Config. Metadata truncation is explicit; archive, source, and complete tool-output budgets remain enforced. These focused edits do not provide arbitrary OOXML feature manipulation or claim native Microsoft Office rendering fidelity.

### Structural checks

The shared Python checker reads DOCX, PPTX, or XLSX without modifying the source. It recognizes Transitional and Strict OOXML namespaces, validates ZIP/XML and internal package relationships, reports document structure, and optionally checks required text or slide/sheet count. DOCX text assertions cover the main body, section-referenced headers and footers, and body-referenced footnotes and endnotes; comments, glossary text, and unreferenced parts or notes do not satisfy them. It uses only the Python standard library. Invalid packages, corrupt or encrypted ZIP members, and report-file write failures produce a JSON failure report on stdout. A passing report does not establish appearance, feature preservation, or calculated formula results.

Excel data and formula tasks skip visual inspection; formatting, layout, chart appearance, printing, or known display problems require checking relevant regions. Basic styling does not itself trigger inspection, and formula recalculation and requested exports remain independent operations. Blank or transparent previews do not pass visual inspection. A failed preview ends visual checking without diagnostic workbooks, PDF conversion, or unrequested print-setting changes; the usable workbook is delivered with the inspection limitation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider registers three bundled candidates and reads their descriptions from the shipped YAML frontmatter at activation. Loaded instruction bodies exclude that metadata. Each loaded skill exposes its own filesystem directory, so the execution tool can resolve the shared checker without relying on the task working directory. Configurable external resources support carriers whose application archive is not readable by Python.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Provider registration and configured resource paths. |
| [`assets/`](assets/) | Three workflows and the read-only OOXML checker. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Skill registry](../skill/README.md) — discovery and precedence.
- [Skill tool](../tool-skill/README.md) — model-visible catalogs and bodies.
- [File delivery](../../deliverables/tool-present/README.md) — current source-path delivery.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the catalog entries and selected instruction body.

#### KV Cache effect

Mounting the provider adds three catalog entries; loading a skill adds its body at the existing skill-tool insertion point. The provider does not add separate prompt sections. Enabling structured authoring adds five stable named JSON tool schemas and compact results; ordinary creation avoids model-generated authoring scripts and intermediate shell calls.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The provider depends on LibreOffice Kit but does not install Python or authoring libraries. The checker requires Python 3.9 or later.
- Structural checks do not judge pagination, clipping, fonts, chart appearance, or Excel recalculation.
- The checker accepts DOCX, PPTX, and XLSX only; legacy, encrypted, and macro-enabled formats require an appropriate separate workflow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
