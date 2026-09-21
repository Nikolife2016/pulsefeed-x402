# pulsefeed-x402-guard — changelog

Versioning policy: a new export or option is a **minor** release; a fix that changes no export or option is a
**patch**; removing or renaming an export, changing the meaning of an option incompatibly, or dropping a Node
line that is still maintained is a **major**. Dropping a Node line that has reached end of life is treated as
minor and is stated here.

## 1.1.0 — 2026-09-21

- New export `PulseFeedUnavailableError`: `verify()` throws it — and only it — when PulseFeed answers with a
  non-2xx status, non-JSON, a body that is not a verdict, when the request fails at the network level, or
  when it times out (the timeout also covers a fetch that ignores its abort signal and a hanging body read).
  **Minor.**
- Security fix: a verification failure is no longer reported as verdict `unknown`. `guardFetch` applies
  `onError` alone to failures (`"allow"` pays, `"block"` throws `PaymentBlockedError`); the decision's
  `reason` is `"verify-error"` (it used to be `"unknown"` when `onError` was `"allow"`). Before 1.1.0, with
  `onError: "block"` an HTTP 503 from PulseFeed still let the payment through.
- Security fix: a blocking verdict blocks regardless of `known`. `{known: false, verdict: "avoid"}` used to
  pass through `onUnknown: "allow"`; `block: ["unknown"]` used to be ignored for a correctly-unknown endpoint.
- `engines.node` raised from `>=18` to `>=20` (Node 18 end of life 30 April 2025; tested on 20 and 24).
- Package source moved to this repository from the PulseFeed service repository; one implementation
  (`src/index.cts`) serves both CommonJS and ESM, so `PaymentBlockedError` is one class in both.
- README example switched to x402 v2 (`@x402/fetch` `wrapFetchWithPaymentFromConfig` + `@x402/evm`);
  the acceptance test executes the README's code verbatim against a mocked PulseFeed and a mocked 402 server.

## 1.0.0 — 2026-07-06

- First release from the service repository (x402 v1 `x402-fetch` example). A 1.0.1 was prepared there but
  never published; 1.1.0 supersedes it.
