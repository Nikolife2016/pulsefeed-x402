# pulsefeed-x402-guard

**Don't let your AI agent pay dead or scam x402 endpoints.** A tiny, zero-dependency safety layer that verifies any x402 service with [PulseFeed](https://pulsefeed.dev/status) **before** your agent pays it — and blocks the risky ones automatically.

~70% of listed x402 endpoints are dead or invalid, and payments are irreversible. This guard is the seatbelt.

## Install

```bash
npm install pulsefeed-x402-guard
```

## Use — wrap your paying fetch

```js
import { guardFetch } from "pulsefeed-x402-guard";
import { wrapFetchWithPayment } from "x402-fetch";

const paying = wrapFetchWithPayment(fetch, wallet);   // your normal x402 payment fetch
const safe = guardFetch(paying);                       // now guarded

// Verified before paying. Throws PaymentBlockedError for dead/scam/risky endpoints.
const res = await safe("https://some-x402-service.example/api");
```

That's it — every payment now passes a live trust check first (dead? scam payTo? price bait-and-switch? unverified receiver?).

## Or check manually

```js
import { verify } from "pulsefeed-x402-guard";

const v = await verify("https://some-x402-service.example/api");
// { known, live, score, verdict: "safe"|"caution"|"avoid"|"unknown", riskLevel, flags, receiverProfile, ... }
if (v.verdict === "avoid") throw new Error("skip it");
```

## Policy

```js
guardFetch(paying, {
  block: ["avoid"],        // verdicts that block payment (default: ["avoid"])
  onUnknown: "allow",       // endpoint not in PulseFeed's index (default: "allow")
  onError: "allow",         // PulseFeed unreachable → fail-open by default
  timeoutMs: 5000,
  onDecision: (d) => console.log(d.decision, d.url, d.trust.verdict),
});
```

Handle blocks:

```js
import { PaymentBlockedError } from "pulsefeed-x402-guard";
try {
  await safe(url);
} catch (e) {
  if (e instanceof PaymentBlockedError) console.warn("blocked:", e.trust.flags);
  else throw e;
}
```

## How it works

The free `GET https://pulsefeed.dev/verify?endpoint=<url>` returns PulseFeed's cached verdict (liveness, trust score, scam/anomaly flags, on-chain receiver profile) from its continuous independent audit of the x402 ecosystem. For a real-time deep check, PulseFeed's paid `/trust` oracle (x402, USDC on Base) returns the full live analysis.

MIT · by [PulseFeed](https://pulsefeed.dev/status)
