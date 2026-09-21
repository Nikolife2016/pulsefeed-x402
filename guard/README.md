# pulsefeed-x402-guard

Safety guard for x402 agent payments. Wraps your paying `fetch`: **before every payment** the endpoint is checked against [PulseFeed](https://pulsefeed.dev)'s free `/verify`, and dead, scam or risky endpoints are blocked. Zero dependencies, Node 20+, **ESM and CommonJS**.

```bash
npm i pulsefeed-x402-guard
```

## With x402 v2 (`@x402/fetch`)

```js
import { guardFetch, PaymentBlockedError } from "pulsefeed-x402-guard";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const paying = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(privateKeyToAccount(process.env.PK)) }],
});
const safe = guardFetch(paying);                    // verified first, then paid — or blocked

try {
  const res = await safe("https://some-x402-service.example/api");
} catch (e) {
  if (e instanceof PaymentBlockedError) console.warn("blocked:", e.trust.verdict, e.trust.flags);
  else throw e;
}
```

CommonJS works the same way:

```js
const { guardFetch, verify, PaymentBlockedError } = require("pulsefeed-x402-guard");
```

## One-off check

```js
import { verify } from "pulsefeed-x402-guard";
const v = await verify("https://some-x402-service.example/api");
// { known, live, score, verdict: "safe" | "caution" | "avoid" | "unknown", flags, advice, ... }
```

## Options

```js
guardFetch(paying, {
  block: ["avoid"],        // verdicts that block payment (default: ["avoid"])
  onUnknown: "allow",      // endpoint not in PulseFeed's index (default: "allow")
  onError: "allow",        // PulseFeed unreachable → fail-open by default; "block" to fail closed
  timeoutMs: 5000,
  onDecision: (d) => console.log(d.decision, d.reason, d.url),
  fetchImpl: fetch,        // the fetch used to reach PulseFeed (for tests / custom environments)
});
```

The payment fetch is **never called** for a blocked endpoint; `PaymentBlockedError.trust` carries the full verdict. A blocking verdict blocks regardless of `known`; `block: ["unknown"]` blocks endpoints PulseFeed has never seen. If PulseFeed itself is unreachable or answers with something that is not a verdict, `verify()` throws `PulseFeedUnavailableError` and `guardFetch` applies `onError` alone (`"allow"` pays, `"block"` throws `PaymentBlockedError` with `reason: "verify-error"`); `block` and `onUnknown` only apply to a healthy PulseFeed answer.

## How it works

`GET https://pulsefeed.dev/verify?endpoint=<url>` returns PulseFeed's cached verdict — liveness, trust score, scam/anomaly flags, on-chain receiver profile — from a daily independent re-audit of the x402 endpoint population. `GET /trust?endpoint=<url>` is the live check; both are free.

## Development

`npm ci && npm run build && npm test` — the test packs a tarball, installs it in a clean directory as a consumer would, and exercises CommonJS, ESM, TypeScript (NodeNext) and the README example against a mocked PulseFeed. The implementation lives once, in `src/index.cts`; the ESM entry only re-exports it, so `PaymentBlockedError` is one class in both formats.

MIT · [PulseFeed](https://pulsefeed.dev)
