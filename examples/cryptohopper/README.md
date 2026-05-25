# examples/cryptohopper

Transform AlgoVault Verifiable-Signal v1.0 envelopes into [Cryptohopper](https://www.cryptohopper.com) external-Signaler GET requests. The transformer is a per-Signaler **curried factory**: bind your Signaler-account `api_key` + `hmac_secret` + `signal_id` + `exchange` once, get a function with the canonical `(signal) => XRequest | null` shape. HOLD verdicts return `null` (skip publish) so HOLDs never burn Signaler points or clutter subscriber feeds.

## Prerequisites

1. Clone + install (root mono-repo):
   ```bash
   gh repo clone AlgoVaultLabs/algovault-integrations
   cd algovault-integrations
   npm install
   ```
2. *(Optional, only for the end-to-end demo)* Become a Cryptohopper Signaler:
   - Cryptohopper's Marketplace is application-gated. Apply via Marketplace → Become a Signaler with a track-record submission. Approval is manual.
   - Once approved, mint an API key + HMAC secret in the user's API section. Copy the Signaler-account `signal_id` from your Cryptohopper API dashboard (this is the static-account ID, NOT a per-emission UUID).
   - Pick the lowercase Cryptohopper exchange ID matching your Signaler config (e.g. `binance`, `kraken`, `kucoin`, `bitfinex`, `bittrex`, `gdax`, `huobi`, `poloniex`, `bitvavo`, `okex`, `binanceus`, `hitbtc`, `bitpanda`, `cex`, `kraken2`).
   - Save the config to one of:
     - environment variables `CRYPTOHOPPER_API_KEY` + `CRYPTOHOPPER_HMAC_SECRET` + `CRYPTOHOPPER_SIGNAL_ID` + `CRYPTOHOPPER_EXCHANGE`, or
     - file `~/.config/algovault/cryptohopper.env` (`KEY=value` lines, one per env var; `chmod 600`).

## Run the example

### Unit tests (no network, no config required)

```bash
npm test
```

Runs the 11 vitest cases for `examples/cryptohopper/transform.ts` alongside the 11 cases for `examples/3commas/` and 9 cases for `examples/ai4trade/`. Pure-function tests; zero network; zero `node:crypto` import in the transform layer. Same path runs in CI on every push.

### End-to-end demo — dry run (default)

```bash
CRYPTOHOPPER_API_KEY=... \
CRYPTOHOPPER_HMAC_SECRET=... \
CRYPTOHOPPER_SIGNAL_ID=... \
CRYPTOHOPPER_EXCHANGE=binance \
  npx tsx examples/cryptohopper/run.ts
```

Fetches a live verdict from `https://api.algovault.com/mcp`, reshapes into a v1.0 envelope, applies the curried Cryptohopper transformer, computes the HMAC-sha512 signature over the path-with-query, and **logs the would-be GET URL + the redacted `X-Hub-Signature` header**. No GET is made. HOLD verdicts log `skipping Cryptohopper GET per transform contract (HOLD wastes points)` and exit 0. The `hmac_secret` is redacted in the dry-log (only the first 4 chars shown).

### End-to-end demo — live GET (opt-in)

```bash
CRYPTOHOPPER_API_KEY=... \
CRYPTOHOPPER_HMAC_SECRET=... \
CRYPTOHOPPER_SIGNAL_ID=... \
CRYPTOHOPPER_EXCHANGE=binance \
CRYPTOHOPPER_LIVE_POST=1 \
  npx tsx examples/cryptohopper/run.ts
```

Same as dry-run, but actually `fetch()`s the GET against `https://www.cryptohopper.com/signal.php`. **A successful GET consumes Signaler points (~10 per published signal) AND emits the signal to every subscriber's bot in real time.** Use only against a sandbox Signaler or with full awareness of the consequence.

## File map

| File | Purpose |
|---|---|
| [`transform.ts`](./transform.ts) | Pure curried mapper: `makeToCryptohopperRequest(config) → (signal) => CryptohopperRequest \| null`. No I/O. No `node:crypto`. |
| [`run.ts`](./run.ts) | End-to-end demo: MCP fetch → reshape → curry-bind → transform → HMAC-sha512 sign → dry-log or live GET. |
| [`tests/transform.test.ts`](./tests/transform.test.ts) | Vitest unit tests (11 cases incl. HOLD-skip, curry-closure isolation, symbol_suffix configurability, `config.signal_id` vs `vs.signal_id` discipline, lowercase exchange contract). |
| `README.md` | This file. |

## Mapping rules

| Verifiable-Signal v1.0 field | Cryptohopper field | Notes |
|---|---|---|
| `composite_verdict.verdict === "buy"` | `type: "buy"` | Default mapping for v1.0 |
| `composite_verdict.verdict === "sell"` | `type: "sell"` | Same |
| `composite_verdict.verdict === "hold"` | `null` (skip publish) | HOLD-skip discipline; HOLDs burn points + clutter feed |
| any other verdict | throws `Error` with `signal_id` | Same as the ai4trade + Nautilus + 3Commas examples |
| `symbol` + `config.symbol_suffix` | `market` | e.g. `"BTC"` + `"USDT"` → `"BTCUSDT"` (default; override `symbol_suffix` to `"BTC"` for BTC-quote pairs) |
| `config.api_key` | `api_key` | From per-Signaler config |
| `config.signal_id` | `signal_id` | Signaler-account-static ID from API dashboard. NOT `vs.signal_id` (per-emission UUID). Per-emission tracking lives on Cryptohopper's side via the natural key `(api_key, signal_id, market, type, timestamp)`. |
| `config.exchange` | `exchange` | Lowercase per Cryptohopper convention; default `"binance"` |
| n/a (computed in `run.ts`) | `X-Hub-Signature` header | HMAC-sha512 over path-with-query (alphabetical-key URL-encoded), raw hex, no `sha512=` prefix |

### HMAC-sha512 contract (this is the AUTHED transport — read carefully)

Cryptohopper's external-Signaler endpoint authenticates each request by HMAC-sha512 of the path-with-query string. The verification on Cryptohopper's side is roughly:

```php
hash_equals($_SERVER['HTTP_X_HUB_SIGNATURE'],
            hash_hmac('sha512', $_SERVER['REQUEST_URI'], $hmac_secret))
```

Three contract details that bite if drifted:
1. **Sign the PATH-WITH-QUERY**, not the request body and not the full URL. Example: sign `/signal.php?api_key=abc&exchange=binance&market=BTCUSDT&signal_id=42&type=buy`.
2. **Sort query keys alphabetically + URL-encode values** before signing. `run.ts` does this via `Object.keys(body).sort()` + `encodeURIComponent()`. Any key reordering or skipped encoding produces a different signature.
3. **Send raw hex, no prefix**. The `X-Hub-Signature` header value is the 128-char hex digest only. Do NOT prepend `sha512=` (Cryptohopper's verification does NOT strip a prefix).

### Marketplace gating

Cryptohopper's Signaler Marketplace requires manual approval (track-record submission + manual review). Until approved, GET requests against the external-Signaler endpoint succeed structurally (HTTP 200) but the signal is dropped — subscribers never see it. The dry-run demo works without approval; the live GET requires approval to actually propagate. Plan accordingly.

### Symbol-mapping note

Cryptohopper Signalers must publish against pairs that exist on the configured `exchange`. For Binance USDT spot/perp (default `exchange=binance`): `market = "BTCUSDT"`. For BTC-quote pairs (e.g. ETHBTC on Binance), set `CRYPTOHOPPER_SYMBOL_SUFFIX=BTC`. For Kraken (lowercase `kraken`), the suffix convention follows Kraken's pair format (typically `USD` for USD-quote spot pairs). Consult your Cryptohopper Signaler dashboard's supported-pair list per exchange.

### Rate-limit + points-cost note

Each published signal consumes Signaler points per Cryptohopper's pricing tier; over-budget signals are dropped silently with an audit-log entry on Cryptohopper's side. There's no documented per-IP rate-limit on the external-Signaler endpoint (the gating mechanism is the points budget). The HOLD-skip discipline in `transform.ts` exists specifically to avoid burning points on non-actionable HOLDs.

## Tested against

- Cryptohopper external-Signaler endpoint at [`https://www.cryptohopper.com/signal.php`](https://www.cryptohopper.com/signal.php), Signaler-Guide docs at [`docs.cryptohopper.com/docs/marketplace-sellers/signaler-guide/`](https://docs.cryptohopper.com/docs/marketplace-sellers/signaler-guide/), live-verified 2026-05-25 (base host is `www.cryptohopper.com`, NOT `api.cryptohopper.com`).
- AlgoVault MCP `crypto-quant-signal-mcp@1.17.0` at `https://api.algovault.com/mcp`.
- Verifiable-Signal v1.0 spec at commit [`06d76e3`](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md).

Re-verify if any upstream drifts.

## License

MIT — see [LICENSE](../../LICENSE) at the mono-repo root.
