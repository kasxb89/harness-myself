# Agent Note: Bind Desktop update discovery to a packaged backend authority

Status: implemented

English | [中文](2026-10-16-desktop-backend-update-authority.zh.md)

## Problem

Product operators need to change each platform's update directory from harnes-api without rebuilding the application. Allowing a product renderer or ambient environment to choose the backend would let unrelated code replace the trusted update configuration. Backend outages or disabled updates must not leave an old available target actionable.

## Decision

The signed application manifest fixes the harnes-api authority. Electron main reads its public status before each ordinary metadata check and accepts only a validated current-platform generic Nightly directory. Remote administration selects that directory but cannot select a new configuration authority, publisher identity, installation command, or downgrade policy. The [Desktop reference](../../../../apps/desktop/README.md#updates) owns configuration and request limits.

Discovery failures invalidate an older available candidate and publish a classified failure. They cannot become an up-to-date result or fall back to the package's publication URL. Downloading, verified, and installing targets remain bound to their already selected provider; backend edits apply after that owned operation ends. Development explicitly binds a loopback authority and reads the same status fields without enabling installation in an unpackaged application.

The [packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md) remains active for release artifacts, publication, signatures, and recovery. Its embedded feed is publication metadata rather than runtime selection. The [shell configuration decision](2026-10-08-desktop-shell-configuration.md) remains active: this authority does not depend on a live Host or direct Cordis patch evaluation.

## Alternatives considered

**Use the packaged feed indefinitely.** Every routing change would require a new installer and would bypass the requested backend control.

**Resolve authority from the renderer, Host, or runtime environment.** Those sources cannot provide the fixed trust decision required by an installed update client. Host dependence also prevents checks while it is unavailable.

**Fall back after discovery failure.** A disabled or withdrawn source could remain usable, hiding the operator's decision and presenting stale availability as current.

## Consequences

A release operator must explicitly configure the trusted backend when packaging, and backend operators must publish compatible signed artifacts at the configured directories. Missing authority affects checks without preventing application startup. Neither backend directory control nor the development HTTP exception relaxes artifact verification or grants installation authorization.
