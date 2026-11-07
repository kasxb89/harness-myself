# Local Windows to macOS builds

## Summary

This opt-in pipeline prepares the complete Desktop shell, Host, production npm closure, Office engine, standalone Node, Python libraries and FFmpeg for either Mac CPU. Existing platform-native release commands remain unchanged.

## Table of Contents

- [Preparation reference](#preparation-reference)
- [Artifact and acceptance reference](#artifact-and-acceptance-reference)
- [Dev Note](#dev-note)

## Preparation reference

Use the D-drive build shell and checkout. The current toolchain uses Windows x64 Node 24.21.0, pnpm 11.28.5, Conveyor 22.3, Zig 0.17.0 and rcodesign 0.29.0. Store the tool paths and the private macOS SDK directory in `D:\YunshuBuild\control\cross-tools.json` (`zig`, `rcodesign`, `sdk`). The SDK is copied privately from an existing Mac installation; no Mac compiler or Mac build cache is needed. Node headers must match the locked primary Node.

After `pnpm run build:official --artifacts-only`, preparation can be verified without making an application or choosing a release version:

```powershell
pnpm --dir apps/desktop exec tsx scripts/package-mac-cross.ts --root D:\YunshuBuild --arch arm64 --prepare-only
pnpm --dir apps/desktop exec tsx scripts/package-mac-cross.ts --root D:\YunshuBuild --arch x64 --prepare-only
```

Before creating either application, confirm the complete version with the user under the Desktop README version rule. Then replace the placeholder below:

```powershell
pnpm --dir apps/desktop exec tsx scripts/package-mac-cross.ts --root D:\YunshuBuild --arch arm64 --build-version <confirmed-version>
pnpm --dir apps/desktop exec tsx scripts/package-mac-cross.ts --root D:\YunshuBuild --arch x64 --build-version <confirmed-version>
```

Initialize Conveyor's private, ACL-protected local root key in its D-drive configuration directory. Cache the exact Electron Darwin ZIPs, verified against the installed Electron package's official checksums, below `downloads\electron\v<version>`. Cache the pinned Sparkle archive below `downloads`. Dependencies, downloads, temporary trees, signing inputs, logs and Conveyor data all stay under the selected D-drive root. Package tarballs can be reused between CPUs only after their source/build key and every SHA match. Mutable installations remain isolated by target. A completed runtime can be reused only for its exact production and materializer inputs after every file passes integrity verification. Missing pnpm content is seeded from existing D-drive stores; indexes are copied, content-addressed bytes can be hard linked, and pnpm still checks integrity with side effects disabled. The exclusive build lock is removed after supervised child termination; a lock left by a killed process must be diagnosed before any manual removal.

## Artifact and acceptance reference

The output is a local ZIP containing an ad-hoc-signed `.app` for manual installation on macOS 15 or later; a bundled native prebuild requires that minimum. It has no Apple notarization. Existing Gatekeeper handling for unsigned test packages still applies. The application and three source-controlled native helpers are built on Windows; locked third-party prebuilds are retained and signed. Mach-O and shebang permissions, framework links and the final runtime integrity inventory are preserved across NTFS. Signing uses local rcodesign ad-hoc signatures, with no online timestamp or notarization submission. The runtime uses an ordinary application directory; the terminal launcher supports both this layout and existing ASAR releases.

The updater retains the existing backend discovery, strict unsigned validation, task confirmation and atomic replacement flow. Its downloaded update artifact remains a DMG. This ZIP is not an updater feed artifact and this command creates no publishable release record. It does not upload, notarize, install on a user's machine or call generation services.

Cross preparation records target execution as **NOT_RUN_REQUIRES_MAC**. A built ZIP records **BUILT_NATIVE_ACCEPTANCE_REQUIRED**, never a passed release. Verify the transferred ZIP SHA, deep/strict signatures, CPU and full runtime inventory on the target Mac, then run actual shell startup, Host, Office, media, account mock, task recovery and updater acceptance. ARM evidence does not validate Intel; Intel requires an Intel Mac or separately authorized Rosetta execution.

## Dev Note

Local cross-built products require target-native acceptance before they qualify. The entry records pending acceptance instead of a passed release.
