---
kind: upgrade-guide
description: "Desktop update checks require an explicitly packaged harnes-api authority instead of using the embedded publication feed."
---

# Configure the Desktop update backend

English | [中文](guide.zh.md)

## Change

Desktop update checks discover their platform directory from harnes-api instead of using the embedded publication feed. Existing release configuration without a backend authority still launches the application, but update checks report that the service is unconfigured; they never fall back to the old feed. Downloaded targets remain bound to their selected source. Packaged macOS and Windows applications, including unsigned packages, now block normal product interaction once the trusted feed confirms a newer release. A confirmed requirement survives check failures and application restarts; installation still requires download approval, integrity checks and task-safe restart confirmation.

## Migration

1. Set `DSH_DESKTOP_UPDATE_CONFIG_ORIGIN` to the trusted HTTPS harnes-api origin in `apps/desktop/.env.windows` or `.env.macos` before packaging a release. Explicit unsigned builds default to `https://8.133.202.230/harness` when this setting is absent. Installed applications ignore environment overrides; distributing a configured release is required to change this authority.
2. In that backend's Client Updates settings, enable updates and configure the intended `mac-arm64`, `mac-x64`, and `win-x64` generic Nightly directories. They must serve compatible release metadata and artifacts for the selected signing mode. See the [Desktop reference](../../../../apps/desktop/README.md#updates) for URL validation and discovery fields.
3. Use Check for Updates in the packaged release to confirm the configured platform responds. Disabled, empty, invalid, and unreachable settings report failure rather than “up to date.” Development launchers default explicitly to `https://8.133.202.230/harness`; an override changes only their child environment and does not enable installation.

4. Distribute this application update once through the previous ordinary update flow. Old binaries cannot acquire mandatory-update behavior from a feed change alone. Confirm that a later, higher target shows the update-required screen and that completing the verified installation clears it; do not infer installed-upgrade or data-retention qualification from packaging alone.
