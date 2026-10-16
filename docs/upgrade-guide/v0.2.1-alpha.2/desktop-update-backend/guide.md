---
kind: upgrade-guide
description: "Desktop update checks require an explicitly packaged harnes-api authority instead of using the embedded publication feed."
---

# Configure the Desktop update backend

English | [中文](guide.zh.md)

## Change

Desktop update checks discover their platform directory from harnes-api instead of using the embedded publication feed. Existing release configuration without a backend authority still launches the application, but update checks report that the service is unconfigured; they never fall back to the old feed. Downloaded targets remain bound to their selected source.

## Migration

1. Set `DSH_DESKTOP_UPDATE_CONFIG_ORIGIN` to the trusted HTTPS harnes-api origin in `apps/desktop/.env.windows` or `.env.macos` before packaging a signed release. Installed applications ignore environment overrides; distributing a configured release is required to change this authority.
2. In that backend's Client Updates settings, enable updates and configure the intended `mac-arm64`, `mac-x64`, and `win-x64` generic Nightly directories. They must serve compatible signed release metadata and artifacts. See the [Desktop reference](../../../../apps/desktop/README.md#updates) for URL validation and discovery fields.
3. Use Check for Updates in the signed release to confirm the configured platform responds. Disabled, empty, invalid, and unreachable settings report failure rather than “up to date.” Development launchers default explicitly to `http://127.0.0.1:3000`; an override changes only their child environment and does not enable installation.
