# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Existing Yunshu desktop users who need help from a human engineer. Engineers are real administrator-managed accounts, never AI personas or fabricated people.

## Product Purpose

Provide a private request, conversation, attachment, delivery and acceptance workflow. This surface is in development; this document does not claim it is deployed.

## Operating Context

Users find an engineer or continue a request under My requests. Independent requests have separate histories. Follow-up messages stay in their original request. Offline engineers can receive messages when the administrator allows it.

## Capabilities and Constraints

Backend configuration supplies people, categories, presence, visibility and upload limits. Identity, permissions, idempotency, receipt persistence and attachment authorization belong to the server/controller. The UI never infers online status from the customer's clock or reports a send as confirmed before its receipt. Human requests do not create AI sessions or call model tools. Payments, quotations, contracts and ratings are outside phase one.

## Brand Commitments

Extend Yunshu's existing product interface, using its semantic tokens, system type, shared controls, icons and light/dark themes. Keep the established visual world and existing login state.

## Evidence on Hand

The approved implementation plan is `output/plans/需求发布-真人工程师在线接单-20261118.txt`. Accepted visual evidence is in `.artifacts/skillhub-store-zAg6mK/wide-light.png` and `.artifacts/digital-employees-zwUqSq/baseline-matched-dark.png`. No engineer roster or profile photographs have been supplied; the production UI must not fabricate them.

## Product Principles

- Start with a message or an image/video; optional details must not block publication.
- Keep independent requests independent and show actual server states.
- Preserve history and unsent drafts during failures and navigation.
- Make upload, unread, message and acceptance states clear without redundant tips.

## Accessibility & Inclusion

Keep keyboard navigation, visible focus, readable light/dark copy and a structural narrow-screen layout. The customer-facing UI supports Chinese and English.
