---
kind: upgrade-guide
description: "Yunshu Desktop uses its own application identity, browser directory and configuration root instead of inheriting another Harness desktop configuration."
---

# Use Yunshu’s independent Desktop configuration

English | [中文](guide.zh.md)

## Change

Yunshu Desktop uses the packaged name `yunshu-desktop`, product application ID `com.yunshu.desktop`, and `yunshu://open`. Its optional terminal command is `yunshu`, and it no longer registers the upstream `dsh` command or URL scheme. Its default Electron browser directory is `appData/yunshu-desktop`; its configuration root is `$DSH_HOME/products/yunshu`, with the logical `desktop` profile under `profiles/desktop`.

The profile patch, home patch, legacy settings import, hot reload and Desktop-installed plugin commands use that configuration root. Old `$DSH_HOME/cordis.patch.yml`, `$DSH_HOME/settings.yaml`, and `$DSH_HOME/profiles/desktop` overrides do not apply. Desktop initializes the new profile from its packaged bundles; it does not automatically copy the old enabled extensions or model configuration.

Account sessions, conversations, task state and user files retain their existing locations. This change does not copy login credentials, rotate refresh tokens, replay tasks or separate every business-data directory from CLI dsh.

## Migration

1. Release operators must set `DSH_DESKTOP_APP_ID=com.yunshu.desktop` in the applicable Desktop release configuration. Packaging rejects the exact upstream IDs `com.deepseek.harness` and `com.deepseek.dsh`. Do not treat source checks as proof of a cross-ID installed upgrade: qualify an actual previous Yunshu installation, co-installed DeepSeek Harness, update, restart and uninstall on each release target before publishing the new identity.
2. Quit both desktop applications before the first upgrade. Keep the existing `$DSH_HOME` and login files. Launch the installed `Yunshu.exe` or Yunshu application bundle directly, rather than a generic `dsh` command or an old product shortcut.
3. Reapply any manual provider or per-model overrides that you still need, and explicitly enable trusted extensions through Yunshu’s own Settings and Plugin Manager. Do not copy the complete old `profiles/desktop` directory or global patch into the new configuration root; that would restore the conflict. The original files remain available for inspection.
4. Replace application-opening links with `yunshu://open`. Confirm that Yunshu and DeepSeek Harness open separate windows and retain their own configuration after restart, then confirm the existing Yunshu account and conversations are still available. See the [Desktop reference](../../../../apps/desktop/README.md#installation-ownership) for storage ownership.

5. Use **Manage yunshu Command…** to install `/usr/local/bin/yunshu` on macOS or the `yunshu.cmd` PATH entry on Windows, then run `yunshu --version` in a new terminal. Yunshu does not replace or remove an old generic `dsh` registration; inspect that registration separately if you no longer need it.
