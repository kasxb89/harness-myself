---
description: "Settings shell, ownerless copy, and durable product-onboarding namespace for the dsh web client: the General section, trigger chrome, and onboarding ledger projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-general

English | [中文](README.zh.md)

## Summary

Use this package to give the dsh web client a Settings panel, connection-recovery control, feature-contributed navigation, and sequential first-run onboarding. Users can open it from the sidebar, retry a failed connection immediately, and access a local configuration file when the Host makes one available on a loopback browser. Feature packages supply their own settings rows, sections, and onboarding steps; this package supplies their shared presentation and the Coding Tools switch without adding onboarding copy.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

The Settings panel uses a shared 800 × 800 layout, bounded by the viewport. Longer sections scroll inside the content column; the Account entry uses the account icon. The panel portals beside `#root` rather than inside it, so a macOS window drag region a chrome row declares later in document order cannot swallow its controls.

<a id="use-this-package"></a>
## Use this package

Users reach the shell through the sidebar's bottom Settings control; feature plugins contribute their pages and onboarding steps through the slot ledgers this shell projects. In both the expanded sidebar and collapsed rail, the control exposes the localized Settings label as its accessible name. The permanent rail stacks a compact 28px connection control below Settings; its accessible name and portaled tooltip carry the complete localized retry action. A wide Settings row keeps the full text pill beside Settings, including the Chinese outage label 连接异常，刷新重试. The pale-yellow retry glyph indicates browser offline suspension. Every recovery attempt uses the shared ongoing loader; wide rows add **Reconnecting** with one to three dots advancing every 500ms. An attempt stays visible for at least 800ms so brief retries do not flicker. Selecting either yellow state starts an immediate retry; press feedback stays within the warning palette. Recovery changes the region to a pale-green check, with **Connected** text in wide rows, for two seconds from the moment it becomes visible. The indicator fades in on appearance and fades out over 150ms on removal; only the wide pill sizes to its current label. Initial startup and uninterrupted healthy operation remain silent. The shell renders the modal panel, the navigation built from `settings.section` entries, and exactly one mounted onboarding step at a time.

Settings uses the [frame’s shared overlay inset](../ui-layout/README.md#window-chrome-seat) and keeps at least 24px of viewport margin. Its mask leaves the Windows caption unpainted; the full-viewport layer still blocks background clicks.

When the section navigation exceeds the panel's available height, the list scrolls independently of the settings content and keeps the Settings title fixed.

In Desktop, the account-row update control shows availability, progress, verification, readiness, and persistent retry feedback. It shares the connection indicator’s 28px height, 8px corners, 14px icon slot, 4px icon gap, and 12px medium text with an 18px line height; update-state border, fill, and text colors remain independently defined. Retry text and its dot use the same brand blue as other update labels; numeric download progress has no ellipsis. The preload carries semantic phase, version, progress, and classified failures; the component resolves every visible and accessible string from the active `settings` locale, including after an in-application language change. Selecting an available update starts downloading; installation requires a separate shell-owned confirmation. A collapsed sidebar shows the same status as a brand-blue dot on its top expand button, including failures. Connection feedback takes priority except during shell-reported installation, when the expected backend disconnect must not hide update status. Failure restores connection feedback. All update controls share one carrier subscription; browser code cannot choose packages or authorize installation. [Desktop updates](../../../apps/desktop/README.md) owns the release workflow. Checking, verifying, and preparing-to-restart tooltips show only the supplied version; without a version, they retain the state label. Desktop update tooltips preserve the complete version and prerelease suffix without adding v or V; their error summaries match the shell update dialogs.

Update-source failures use the same retry control with localized guidance for missing service bindings, unavailable or invalid configuration, disabled updates, unconfigured devices, and development builds. They do not report that the application is up to date; update addresses remain owned by the Desktop main process. During download and verification, selecting the status reopens the shell's progress window even while the original action remains pending; checking and installation keep the control unavailable.

`sectionGroups` maps a parent section id to installed section ids shown as tabs inside it. Yunshu groups Dream Skin settings inside Skin Market, retaining the installed skin’s wallpaper, accent and theme controls. Removing or disabling the parent restores each member’s independent navigation entry; grouping never installs, disables or removes plugins or edits skin preferences. Duplicate membership and nested groups are rejected at load.

Settings visibility and section selection live in the shell owner store. Client features can emit the typed local `ui-settings/open-section` event with an installed `settings.section` id to open that section. Unknown or removed ids leave the current dialog unchanged; the listener is released with the shell registration. The local `ui-settings/closed` event fires once when the live shell changes from open to closed, allowing features to refresh after an editor is used. Mounting, selection changes and shell teardown do not emit it. The shell supplies the effective Settings binding to the contributed launcher for menu keycaps and `aria-keyshortcuts`; the fallback button uses the same binding for hover and keyboard-focus hints and `aria-keyshortcuts`. The Settings command (Desktop: `Mod+,`; Windows/macOS Web: `Mod+Alt+,`) toggles the dialog when Settings is in front or no modal is open; the sidebar control opens the same dialog. The command cannot open or close Settings while the shortcut reference or another modal is in front. Held-key repeats do nothing. Initial focus lands on the selected section in the navigation, or on the title when no sections are available, without drawing a focus outline. Tab and directional navigation retain their visible focus indicators. `Mod+/` can open the shortcut reference above Settings; `Escape` closes the top dialog and restores focus to its invoking control. Return focus omits outlines after shortcut, Escape, or pointer dismissal.

### The General section

The current release version appears at the bottom of General Settings in Web and Desktop, using the build’s `DSH_CLIENT_VERSION` metadata and the active language. Desktop keeps a **Check for updates** button beside the version and a permanent action above **Mobile** in the sidebar on macOS and Windows. Without a discovered release, both perform a manual check. When a release is available, downloaded, or can recover from a download or installation failure, both show **Update version** and continue that update through the shell’s download or installation confirmation instead of checking again. Updates remain optional; dismissing a prompt preserves access to the application. Tooltips explain loading, failure, or unavailable update sources. Checks, downloads, verification, and installation show their current state. Duplicate checks, open confirmations, and installation disable the action; download and verification can reopen the progress window. Ordinary browsers and older v1 preloads without the manual-check capability omit these buttons; older preloads retain the original status actions. Partial Desktop builds with this capability retain the check even without version metadata.

The Coding Tools switch controls the shared `ui-settings.enabled` preference described by [ui-settings](../ui-settings/README.md#use-this-package). It is available in both Web and desktop, follows accepted changes immediately, and disables duplicate input while a write settles. A failed write displays localized retry guidance.

The General section holds the built-in Coding Tools and Current version rows alongside rows registered into `settings.general.item` by feature packages. Each registrant owns its row copy and behavior. The Appearance row, for example, lives in ui-theme.

<a id="announcements"></a>
### Announcements

The sidebar's **Announcements** action follows **Check for updates** and precedes **Mobile**; it remains available in Web and the collapsed rail. Opening it reads the current deployment's public announcement switch and list through the authenticated Host. Publication dates use the active UI language and local timezone; content and optional details render as plain text, including any source HTML or Markdown. Disabled, empty and legacy-null lists show **No announcements**. An unsupported older service, invalid data, network failure or unavailable read shows localized guidance and **Retry**. A failed refresh retains the last successful list; an observed login change clears it. Closing cancels the active request and discards the list, so reopening always reads again. The shared Modal owns Escape, outside dismissal, focus restoration, viewport clearance and internal scrolling.

<a id="customer-support"></a>
### Customer support

The sidebar's **Support** action follows **Announcements** and opens the current support QR code in a shared modal. The authenticated Host reads the deployment's independent customer-service settings without requiring product sign-in; the [Credits Host](../../host/credits-index/README.md) owns the status projection and accepted image URLs. Titles and descriptions render as plain text. Missing, disabled or unconfigured settings show a localized unconfigured message; the login QR is never substituted. Network interruptions, timeouts, invalid settings and unavailable reads have separate guidance. Image loading failures offer an explicit retry that reads the settings again. Closing cancels the current read and discards its content; reopening always fetches current settings. The QR image suppresses referrers, stays inside narrow viewports, and is removed before refresh so an obsolete code cannot remain visible. Escape, outside dismissal and focus restoration follow the shared Modal.

### Opening the configuration file

On a loopback browser, the shell renders **Open configuration file** only when the Host confirms that a provider-owned local document can be prepared. The action opens that document in the native text editor (bypassing the browser file association on macOS). Remote browsers never register the action and never issue the privileged settings read.

### Onboarding steps

The onboarding ledger projects in ascending order and mounts exactly one step at a time. Registrants own durable completion, capability readiness, copy, mutations, and their visible wrapper, so independently registered flows cannot stack and the shell does not become a second configuration fact source. Visible steps own their dialog chrome and app-root `inert` lifecycle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The shell declares settings.launcher for an account-owned sidebar menu and retains the Settings button as its fallback. The launcher receives settingsOpen, whose false-to-true edge marks one Settings entry, so a registrant acts once per entry instead of on every re-render inside one open. Closing the dialog returns focus to the active launcher.

<details>
<summary>Implementation internals — click to expand</summary>

The shell owns the chrome and the projections; it contributes the Coding Tools and Current version rows, while feature registrants own their additional content and copy.

### Ledger projections

The navigation is a projection of the `settings.section` ledger; nav labels may be locale-following thunks, resolved through `resolveSlotLabel` and re-rendered on the section ledger bump or the locale revision (an optional `ctx.get('locale')` read; no hard locale dependency). The onboarding ledger projects in ascending order; the active registrant receives its id, `complete()`, and an `openSection(id)` callback, and completing or skipping transfers ownership to the next entry.

### Connection recovery

The shell is an explicit recovery consumer, so it injects Connection directly rather than adding lifecycle controls to `ctx.remote`. Its private hooks compartment binds `ctx.connection.state`, while the component receives only the selected state and an injected callback for `ctx.connection.reconnect()`. `ConnectionIndicator` owns the inline presentation and receives all visible and accessible copy from the `settings` locale namespace; the shell owns the 800ms minimum-visible hold for the connecting state and the two-second recovered-state timer, which starts when the recovered indicator becomes visible after the hold.

### Document availability

On a loopback page, the Client loads the provider's `hasDocument` capability through `settings/describe` and renders **Open configuration file** only when the Host confirms that a provider-owned local document can be prepared. The action calls the pathless, browser-authenticated `settings/openSettingsDocument` Remote; the Host resolves the provider path again, materializes an absent document, and hands it to a native text editor (`open -t` on macOS, bypassing a browser file association; the desktop file association on Linux and Windows; Windows association after `wslpath -w` translation on WSL). Open failures keep the action available and render a localized error. Reopening the dialog or reconnecting refreshes availability after a transient read failure or Host topology change. Non-loopback pages retain the Client policy that withholds this native action and its settings read.

### Host half

The Host half declares `welcomeNoticeVersion` as a volatile field of the `ui-settings-general` entry Config. The welcome step contributed by ui-settings-models reads and writes its `welcomeNoticeVersion` through the existing public settings boundary; the shell itself remains policy-free.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the settings surface family and the composition model.

- [ui-settings](../ui-settings/README.md) — the domain base whose slot types and scope service this shell builds on.
- [ui-sidebar](../ui-sidebar/README.md) — the sidebar shell hosting the `sidebar.settings` seat.
- [ui-settings-models](../ui-settings-models/README.md) — the feature package contributing the DeepSeek onboarding step.
- [settings](../../settings/README.md) — the durable user-settings seam and its file provider.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the composition model behind the ledgers.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the shell itself provides versus what features must supply; they are current package constraints.

- **Additional General rows require their feature plugins** — the shell supplies Coding Tools and Current version; feature plugins supply the remaining preferences.
- **The Windows caption badge keeps a side-opening bubble** — `DesktopUpdateBadge` occupies `sidebar.toggle.badge` in the caption and requests `side="right"`, so the Desktop-owned menu text can cover its bubble while the sidebar is collapsed on Windows; the sidebar toggle and New Session bubbles open below the caption instead (#4688).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
