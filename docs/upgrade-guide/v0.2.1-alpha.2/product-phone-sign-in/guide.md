---
kind: upgrade-guide
description: "Product startup now requires the product's phone session instead of official DeepSeek sign-in or a configured provider API key."
---

# Product phone sign-in replaces official account onboarding

English | [中文](guide.zh.md)

## Change

The desktop product previously accepted an official DeepSeek account or a configured provider API key to pass its welcome screen. Startup now follows the product's phone session. A valid existing phone session opens the workspace without another sign-in. Otherwise, the Zhishu Technology welcome offers **Sign in with phone**, which opens the **Balance** sign-in form.

The default product disables the official account UI and automatic API-key onboarding. Existing provider credentials remain stored, but they do not replace product sign-in. The phone sign-in backend supplies the account's dedicated relay credential; users do not enter that key manually.

## Migration

1. Restart the upgraded product. If the welcome appears, choose **Sign in with phone** and complete phone verification in **Balance** using your existing product account.
2. Keep existing provider credentials; no credential-file migration is required. If generation reports `RELAY_MISSING` for an older phone session, use **Balance → Sign out**, then sign in again once to obtain its relay credential.
3. For a custom profile overlay, keep `ui-settings-account` disabled and set `ui-settings-models.config.credentialOnboarding` to `false` so the official login and automatic key form stay hidden.
4. Confirm **Balance** shows your account and balance, then restart. The valid phone session should open the workspace directly. A signed-out welcome should show the product name and phone sign-in action without the DeepSeek HARNESS logo or **Add API Key**.
