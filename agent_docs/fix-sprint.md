# fix-sprint memory — Paseo

## How E2E testing works here

Use [development](../docs/development.md), [testing](../docs/testing.md), and [QA](../docs/qa.md). Browser specs use `packages/app/playwright.config.ts` and start isolated daemons. Run specific files from their package directory. Never restart the main daemon or run the full suite.

## Stack-specific pitfalls

Build protocol/client declarations before cross-package typechecking. Use the repository UI primitives and [forms](../docs/forms.md).

## Catch-alls

Account lifecycle and credential ownership constraints live in [provider accounts](../docs/provider-accounts.md). Account fixtures must explicitly enable verified accounts when simulating completed setup.

## Reviewer angles relevant here

Account lifecycle and persistence; selection and continuation validity; settings and picker hierarchy; narrow-layout interaction.

## Retro log

- 2026-09-08: Reviewed account removal, ordering, activation, profile selection, usage presentation, and continuation. Added regression coverage for stable order, active account limits, explicit activation, and invalid continuation selections. Browser proof covers removal with retained login, restore, ordering, the missing-metrics context indicator, and tab-menu continuation against an isolated daemon. Additional coverage checks sticky model/pool/workload choices across resets and restarts, and account-specific tooltip quota. Live authenticated-provider and native-device proof remain separate.
