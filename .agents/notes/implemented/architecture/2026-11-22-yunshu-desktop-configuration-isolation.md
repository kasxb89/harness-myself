# Agent Note: Yunshu Desktop configuration and application identity

Status: implemented

English | [中文](2026-11-22-yunshu-desktop-configuration-isolation.zh.md)

## Problem

A branded Electron window can still share its package-derived browser directory, single-instance lock, URL scheme and profile configuration with an upstream Harness installation. Launching one product can focus the other, and an existing profile or global patch can replace its model or interface configuration. Renaming the visible application alone does not establish separate ownership.

## Decision

Yunshu uses a product-specific packaged application identity and browser directory before it claims the single-instance lock. Its external opening scheme is `yunshu`; the generic `dsh` scheme remains outside its ownership. Packaging rejects the exact upstream application IDs instead of silently publishing another installer with the same registration identity.

Desktop configuration has a separate root under the existing data home. Its profile, home patch, legacy-settings import, hot reload and installed plugin-management commands use that root together. Keeping only the profile path separate would still allow a shared home patch to replace the product configuration. The [Desktop reference](../../../../apps/desktop/README.md#installation-ownership) owns the paths and behavior.

Account and conversation storage stays at the existing data home. The product does not copy active refresh credentials into a second home, rotate existing sessions or rewrite task history as part of configuration isolation. A new profile starts with the packaged bundles; ambiguous old overrides and enabled extensions do not activate automatically.

## Alternatives considered

**Keep a shared identity and provide a repair launcher.** A launcher can choose the correct executable or browser directory for one run, but installation registration, URL routing and profile overrides still compete. It cannot define the product’s normal ownership.

**Move the entire data home automatically.** Copying an active login can create two refresh owners. Moving mixed historical storage also needs provenance and consistency rules that a configuration repair cannot infer. Keeping business data in place preserves the existing account and task paths without claiming a complete data migration.

**Copy the old Desktop profile wholesale.** The profile can contain the foreign configuration causing the conflict. Only an independently qualified product-owned preference can be migrated; the full old activation tree is not an authoritative Yunshu source.

## Consequences

Yunshu and upstream Harness installations have separate application and configuration ownership. Existing business data can still share the same data home by design, so this decision does not establish complete business-data isolation. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-alpha.2/yunshu-product-isolation/guide.md) owns user and release-operator actions.

An application-ID transition requires actual installed-upgrade and coexistence qualification, including uninstall retention of the other product. Source tests and a successful package build cannot establish those results. Configuration tests must exercise the normal Loader path with conflicting old profile and home patches, while keeping existing account and task data unchanged.
