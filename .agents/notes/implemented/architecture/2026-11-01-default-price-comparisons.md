# Agent Note: Compare dated default model prices without changing billing

Status: implemented

English | [中文](2026-11-01-default-price-comparisons.zh.md)

## Problem

A single recharge discount would mix payment amounts with model prices and hide differences between token directions and media specifications. A public pricing response can also contain internal fields that the recharge page does not need.

## Decision

The Host exposes a bounded, credential-free projection of published retail rows paired with dated official references. Each row retains its exact unit, specification, direction, source and comparison conditions. A whitelist excludes procurement costs and channel identifiers. Missing or invalid reference metadata cannot produce a discount claim.

The recharge page states that comparisons use default prices and that the submission quote determines actual charges. It computes decimal ratios independently per row, rounds displayed discount claims conservatively, and provides the underlying amounts and official source. Comparison reads have their own cancellation and retry lifecycle; they cannot create payment orders or generation requests. The [Host reference](../../../../packages/host/credits-index/README.md) and [client reference](../../../../packages/client/ui-credits/README.md) own the operational details.

## Alternatives considered

**Advertise one discount for all models.** Input and output prices and media specifications differ, so a single multiplier would conceal material conditions.

**Treat the default retail price as an account quote.** Current account data does not establish every group or subscription adjustment. Billing remains with the existing quote and submission paths.

**Pass through the complete pricing document.** Public comparison metadata is sufficient; copying unrelated fields broadens disclosure and couples the page to internal pricing details.

## Consequences

Users can inspect a precise dated comparison without changing their payment amount or selected model. Reference prices can age and need server-side maintenance. An older API without reference metadata keeps the payment flow usable and omits the comparison card. Keyless tests use actual public API response fixtures through the Host and built browser; they do not establish current supplier availability or paid rendering quality.
