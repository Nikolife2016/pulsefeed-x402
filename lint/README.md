# x402-payable

**Is this x402 endpoint actually payable?**

`Returned a 402` and `is a payable product` are not the same claim. This checks the difference.

```bash
npx x402-payable https://api.example.com/v1/data
```

```
  https://api.example.com/v1/data
  ok   placeholder-url        no unfilled path placeholders
  ok   reachable              HTTP 402
  ok   http-402               returns 402 Payment Required
  ok   challenge              requirements in the PAYMENT-REQUIRED header (x402 v2)
  ok   scheme-in-spec         scheme exact is in the x402 spec
  ok   default-client-can-pay a default x402-fetch client can settle this
  ok   mainnet                network eip155:8453
  ok   receiver               payTo 0x52E2…f3ea
  ok   amount-parses          price $0.001 USDC on Base (6 decimals)

  → PAYABLE  (2 payment options offered)
```

Zero dependencies. No account, no API key, and **no call to any service of ours** — it talks
only to the endpoint you give it. Works offline against your own staging URLs.

## What it checks, and why each check exists

Every one of these is here because it was got wrong in production — by us, first. The write-up
is at [pulsefeed.dev/correction](https://pulsefeed.dev/correction).

| Check | What it catches |
|---|---|
| `challenge` | x402 v2 moved the payment requirements out of the JSON body and into the `PAYMENT-REQUIRED` header. A body-only reader reports live v2 services as broken. |
| `body-header-agree` | When both are present and disagree, a v2 client pays what the **header** says — which is not what a body-only check displays. |
| `scheme-in-spec` | The spec defines `exact`, `upto`, `auth-capture`, `batch-settlement`. Anything else settles outside the facilitator, so funds are not held in escrow. |
| `default-client-can-pay` | In-spec but not `exact`: a plain `x402-fetch` client cannot settle it without work. A compatibility note, not a red flag. |
| `amount-is-a-price` | Under `upto` and `auth-capture`, `amount` is the **maximum authorized draw**, not the per-call cost. Comparing it against other services' prices compares two different quantities. |
| `mainnet` | A testnet sandbox priced in dollars is not a product. |
| `placeholder-url` | `:id`, `{id}`, `/example` — strings copied out of documentation. They often return a perfectly valid 402. |
| `amount-parses` | Amount must be a decimal integer (hex and exponent notation misread silently), and USDC is 6 decimals on most chains and **18 on BSC**. Assuming 6 everywhere is a 10¹² error. |
| `receiver` | No `payTo`, or the zero address — a payment sent there cannot reach anyone. |

Three more checks from the same list are about how you *aggregate*, not about a single URL, so
they are not in this tool: count distinct operators rather than endpoints, state the observation
count beside any uptime figure, and version your measurement method so your own fixes do not
read as market movement.

## In CI

```yaml
- run: npx x402-payable https://api.example.com/v1/data
```

Exit codes: `0` payable · `1` not payable · `2` undetermined (unreachable/timeout) · `3` usage.

## As a library

```js
import { lint } from "x402-payable";
const r = await lint("https://api.example.com/v1/data");
// { url, verdict: "payable" | "not-payable" | "unknown", offers, checks: [{ id, ok, level, msg }] }
```

`--json` gives the same object on the command line.

## Scope

This tells you whether an endpoint is *payable right now*. It says nothing about whether the
operator is trustworthy over time — that needs a history you cannot get from one request.

MIT.
