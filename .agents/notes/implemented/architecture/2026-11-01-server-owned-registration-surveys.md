# Agent Note: Bind registration surveys to server-owned enrollment

Status: implemented

English | [中文](2026-11-01-server-owned-registration-surveys.zh.md)

## Problem

A first local login can belong to an existing account or another device. Using it as registration evidence would ask old users for new-user information and could attach a late answer to the wrong signed-in account. A form inside the login page also disappears when successful login returns to chat.

## Decision

The server creates enrollment in the actual new-phone registration transaction. The client reads current-user survey state after the authenticated account changes and opens a global dialog only for confirmed pending enrollment. Submitted surveys stay closed. Deferral is explicit and remains available through the balance page without blocking ordinary product use.

The Host binds reads and writes to the current authenticated owner. Client owner guards protect against account changes and never become upstream user identifiers. A lost submission acknowledgement triggers a canonical read; an unresolved answer remains locked until explicit verification, while the user can close and reopen the dialog. Survey failure does not undo login or automatically repeat a write. The [Host reference](../../../../packages/host/credits-index/README.md) and [client reference](../../../../packages/client/ui-credits/README.md) own the wire and UI details.

## Alternatives considered

**Mark the first local login as a new registration.** Local state cannot establish account history, MFA completion or registration on another device.

**Require the questionnaire before product access.** A survey or network outage would turn a completed login into a product-access failure. Explicit deferral preserves access and a later completion path.

**Store the answer only in client settings.** Device-local state would lose the registration record and let another device repeat an already submitted survey.

## Consequences

New users can select several product scenarios and add optional notes. The administrator receives an account-bound registration record. Older APIs without survey support retain the existing login experience. Keyless fixtures cover the authenticated API contract, current-owner isolation, deferred completion and the built browser; they do not perform real SMS delivery or production registration.
