# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Existing Yunshu desktop users who need help from a human engineer. The directory can contain administrator-published service profiles as well as real engineers. A service profile represents a service capability and a platform reception route, not a separate person or an online engineer.

## Product Purpose

Provide a private request, conversation, attachment, delivery and acceptance workflow. This surface is in development; this document does not claim it is deployed.

## Operating Context

Users choose a service profile or engineer, or continue a request under My requests. Requests submitted through a service profile first enter the platform's central unassigned queue; an administrator assigns a real engineer. Independent requests have separate histories. Follow-up messages stay in their original request. Offline real engineers can receive messages when the administrator allows it.

## Capabilities and Constraints

Backend configuration supplies service profiles, real people, categories, presence, visibility and upload limits. The approved initial service catalog may contain 100 service profiles; this is not a claim that 100 independent engineers are online. Service-profile names and capabilities describe the offered services. They must not imply fabricated personal identities, presence or work history. Directory counts always come from the received catalog, not a client-side constant.

The separately approved 100 customer profiles are administrator-only records, not registered product users, login accounts or a public customer roster. They are outside this client directory.

Identity, permissions, idempotency, receipt persistence, assignment and attachment authorization belong to the server/controller. The UI distinguishes the selected service profile from the actual assigned engineer. It never infers online status from the customer's clock or reports a send as confirmed before its receipt. Historical message authors come from the message receipt; missing names remain generic rather than being inferred from the current assignee. Human requests do not create AI sessions or call model tools. Payments, quotations, contracts and ratings are outside phase one.

## Brand Commitments

Extend Yunshu's existing product interface, using its semantic tokens, system type, shared controls, icons and light/dark themes. Use the shared checklist icon for the request sidebar entry and page heading so it is distinct from Chat. Keep the established visual world, brand logo and existing login state.

## Evidence on Hand

The original approved implementation plan is `output/plans/需求发布-真人工程师在线接单-20261118.txt`. The November 18 follow-up authorizes a backend-configured service catalog routed to central platform reception, with real engineer assignment afterward. Accepted visual evidence is in `.artifacts/skillhub-store-zAg6mK/wide-light.png` and `.artifacts/digital-employees-zwUqSq/baseline-matched-dark.png`. No real engineer roster or portrait photographs have been supplied; the client must not fabricate them. Service-profile artwork, if supplied, must remain distinguishable from a real person's portrait.

## Product Principles

- Start with a message or an image/video; optional details must not block publication.
- Keep independent requests independent and show actual server states.
- Explain platform reception before submission, and show the actual assignee only after assignment.
- Preserve history and unsent drafts during failures and navigation.
- Make upload, unread, message and acceptance states clear without redundant tips.

## Accessibility & Inclusion

Keep keyboard navigation, visible focus, readable light/dark copy and a structural narrow-screen layout. The customer-facing UI supports Chinese and English.
