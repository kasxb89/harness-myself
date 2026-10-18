# Agent Note: SkillHub preserves isolation and publishes loadable skill metadata

Status: implemented

English | [中文](2026-10-18-skillhub-windows-encoding.zh.md)

## Problem

Windows users see failed SkillHub recommendations and tabs detached from the main content. Python `-I` ignores `PYTHONIOENCODING`, so the existing environment setting does not establish UTF-8 for Windows pipe output containing Chinese or emoji. A tab margin also overrides the page's automatic horizontal margins.

The official `@clawhub_ivangdavila/writing` skill installs with `name: Writing`. The global `isSkillName` rule rejects uppercase names, so a successful download can leave the skill absent from the conversation catalog.

## Decision

The Host keeps the unmodified official CLI and Python isolation, and explicitly enables UTF-8 with `-I -X utf8`. A shared centered content container aligns the heading, tabs, search and results.

With the user's authorization, installation lowercases only the YAML `name` scalar before publication, for example `Writing` to `writing`, then applies the existing global name rule. Source-range replacement preserves other metadata, comments and body bytes. The store retains the official display name and installation coordinate.

## Alternatives considered

**Rely on `PYTHONIOENCODING`.** Rejected because isolated Python ignores it. Explicit interpreter configuration keeps isolation without depending on the machine's ANSI encoding.

**Relax the global name rule or invent replacement names.** Rejected because this integration only needs case normalization. Slug substitution, space replacement and Chinese transliteration would introduce unrelated naming behavior.

**Serialize the complete YAML document.** Rejected because rewriting unrelated metadata, comments or formatting exceeds the authorized adaptation.

## Consequences

Invalid names after lowercasing, missing required frontmatter fields and anchored names that require a case change fail before publication. Rejecting the latter preserves the meaning of aliases to that name. Already lowercase names remain byte-identical. Existing installation staging, lockfile ownership and catalog invalidation remain responsible for publication and immediate discovery.

## Testing

A real Python regression fails with the previous arguments and passes with explicit UTF-8. Loader composition exercises installation and a previously loaded catalog; metadata regressions cover preserved content and rejected inputs. Real Chromium geometry checks cover 16 combinations of Windows/macOS styles, light/dark themes and widths of 1833, 1100, 640 and 360 pixels.

Live checks on macOS prepare a fresh official CLI cache, return 20 recommendations and 20 search results, and install and discover `writing-polish`. The official Writing skill is absent from the catalog before adaptation; afterward its name is `writing`, the catalog finds it and its unchanged 4994-byte body loads. These checks do not include execution on Windows or establish a full GUI/Web suite result.
