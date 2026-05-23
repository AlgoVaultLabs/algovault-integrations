# examples/3commas

Transform AlgoVault Verifiable-Signal v1.0 envelopes into [3Commas](https://3commas.io) Signal Bot custom-signal webhook bodies. The transformer is a per-bot **curried factory**: bind your bot's `secret` + `bot_uuid` (and optional `tv_exchange` / `symbol_suffix`) once, get a function with the canonical `(signal) => XRequest | null` shape. HOLD verdicts return `null` (skip publish) so HOLDs never trigger a bot action.

## Prerequisites

1. Clone + install (root mono-repo):
   ```bash
   gh repo clone AlgoVaultLabs/algovault-integrations
   cd algovault-integrations
   npm install
   ```
2. *(Optional, only for the end-to-end demo)* Create a 3Commas Signal Bot:
   - Sign up at [3Commas](https://3commas.io). Pricing tier matters for rate limits (Starter 5 req/min · Pro 50 · Expert 480 read + 120 write).
   - Create a Signal Bot of "Custom Signal" type. Copy the **webhook URL**, **secret token**, and **bot UUID** from the bot's settings.
   - Save the config to one of:
     - environment variables `THREE_COMMAS_WEBHOOK_URL` + `THREE_COMMAS_SECRET` + `THREE_COMMAS_BOT_UUID`, or
     - file `~/.config/algovault/3commas.env` (`KEY=value` lines, one per env var; `chmod 600`).

## Run the example

### Unit tests (no network, no config required)

```bash
npm test
```

Runs the 11 vitest cases for `examples/3commas/transform.ts` alongside the 9 cases for `examples/ai4trade/`. Pure-function tests; zero network. Same path runs in CI on every push.

### End-to-end demo — dry run (default)

```bash
THREE_COMMAS_WEBHOOK_URL=... \
THREE_COMMAS_SECRET=... \
THREE_COMMAS_BOT_UUID=... \
  npx tsx examples/3commas/run.ts
```

Fetches a live verdict from `https://api.algovault.com/mcp`, reshapes into a v1.0 envelope, applies the curried 3Commas transformer, and **logs the would-be POST body + the webhook URL it would hit**. No POST is made. HOLD verdicts log `skipping 3Commas POST per transform contract` and exit 0.

### End-to-end demo — live POST (opt-in)

```bash
THREE_COMMAS_WEBHOOK_URL=... \
THREE_COMMAS_SECRET=... \
THREE_COMMAS_BOT_UUID=... \
THREE_COMMAS_LIVE_POST=1 \
  npx tsx examples/3commas/run.ts
```

Same as dry-run, but actually `fetch()`s the POST. **A successful POST against a live Signal Bot triggers a real trading action on the bot's configured exchange.** Use only against a sandbox bot or with full awareness of the consequence.

## File map

| File | Purpose |
|---|---|
| [`transform.ts`](./transform.ts) | Pure curried mapper: `makeToThreeCommasRequest(config) → (signal) => ThreeCommasRequest \| null`. No I/O. |
| [`run.ts`](./run.ts) | End-to-end demo: MCP fetch → reshape → curry-bind → transform → dry-log or POST. |
| [`tests/transform.test.ts`](./tests/transform.test.ts) | Vitest unit tests (11 cases incl. HOLD-skip, curry-closure isolation, symbol_suffix configurability, ISO 8601 passthrough). |
| `README.md` | This file. |

## Mapping rules

| Verifiable-Signal v1.0 field | 3Commas field | Notes |
|---|---|---|
| `composite_verdict.verdict === "buy"` | `action: "enter_long"` | Default mapping for v1.0 (no enter-vs-exit differentiation in the envelope) |
| `composite_verdict.verdict === "sell"` | `action: "enter_short"` | Same |
| `composite_verdict.verdict === "hold"` | `null` (skip publish) | HOLD-skip discipline; preserves bot signal-feed signal-to-noise |
| any other verdict | throws `Error` with `signal_id` | Same as the ai4trade + Nautilus examples |
| `symbol` + `config.symbol_suffix` | `tv_instrument` | e.g. `"BTC"` + `"USDT.P"` → `"BTCUSDT.P"` (Binance perp default; override to `"USDT"` for spot bots) |
| n/a | `tv_exchange` | From `config.tv_exchange`, default `"BINANCE"` |
| `price` | `trigger_price` (string) | `String(price ?? 0)` |
| `executed_at` (ISO 8601) | `timestamp` (string) | ISO 8601 passthrough per live 3Commas docs (the `{{timenow}}` placeholder renders as ISO too); `null` → current UTC ISO |
| `config.secret` | `secret` | From per-bot config |
| `config.bot_uuid` | `bot_uuid` | From per-bot config |
| `config.max_lag` | `max_lag` | Default `"300"` (seconds; 3Commas rejects signals older than this) |

### Symbol-mapping note

3Commas Signal Bots use TradingView ticker conventions. For Binance USDT-margined perpetual futures (AlgoVault's default `exchange=BINANCE` context): `tv_instrument = "BTCUSDT.P"`. For Binance spot: `tv_instrument = "BTCUSDT"`. Set `THREE_COMMAS_SYMBOL_SUFFIX` accordingly per your bot's configured market. Other venues (Bybit perps `BTCUSDT.P` via `BYBIT`, OKX swap `BTC-USDT-SWAP`, etc.) require both `tv_exchange` and `symbol_suffix` overrides — consult your bot's pair list.

### Rate-limit note

3Commas API rate limits (per your plan): Starter 5 req/min · Pro 50 · Expert 480 read + 120 write. Sustained over-limit returns HTTP 418 (temporary block, 2 min – 3 days). Webhook POSTs are not separately rate-limited in the docs but are gated by your bot-action rate against the underlying exchange API budget.

## Tested against

- 3Commas Signal Bot custom-signal JSON schema at [`help.3commas.io/en/articles/8894481`](https://help.3commas.io/en/articles/8894481-signal-bot-json-file-in-custom-signal-type), live-verified 2026-05-23 (timestamp field accepts ISO 8601 format).
- AlgoVault MCP `crypto-quant-signal-mcp@1.17.0` at `https://api.algovault.com/mcp`.
- Verifiable-Signal v1.0 spec at commit [`06d76e3`](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md).

Re-verify if any upstream drifts.

## License

MIT — see [LICENSE](../../LICENSE) at the mono-repo root.
