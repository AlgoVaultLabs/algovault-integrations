# examples/ai4trade

Transform AlgoVault Verifiable-Signal v1.0 envelopes into [ai4trade.ai](https://ai4trade.ai) `POST /api/signals/realtime` request bodies. HOLD verdicts are skipped (the transformer returns `null`) to preserve quota and feed signal-to-noise.

## Prerequisites

1. Clone + install:
   ```bash
   gh repo clone AlgoVaultLabs/algovault-integrations
   cd algovault-integrations
   npm install
   ```
2. *(Optional, only for the end-to-end demo)* Issue an ai4trade Bearer token: register an agent at [ai4trade.ai](https://ai4trade.ai) per the [SKILL.md registration flow](https://ai4trade.ai/SKILL.md), then save the token to one of:
   - environment variable `AI4TRADE_BEARER`, or
   - file `~/.config/algovault/ai4trade-bearer.env` (single line, `chmod 600`).

## Run the example

### Unit tests (no network, no token required)

```bash
npm test
```

Runs the 9 vitest cases against `transform.ts`. Pure-function tests; zero network. Same path runs in CI on every push.

### End-to-end demo — dry run (default)

```bash
AI4TRADE_BEARER=... npx tsx examples/ai4trade/run.ts
```

Fetches a live verdict from `https://api.algovault.com/mcp` (`get_trade_call` for `BTC` / `5m` / `BINANCE`), reshapes it into a v1.0 envelope, transforms to an ai4trade request body, and **logs the would-be POST to stdout**. No POST is made to ai4trade. HOLD verdicts log `skipping ai4trade POST per transform contract` and exit 0.

### End-to-end demo — live POST (opt-in)

```bash
AI4TRADE_BEARER=... AI4TRADE_LIVE_POST=1 npx tsx examples/ai4trade/run.ts
```

Same as dry-run, but actually `fetch()`s the POST. Consumes ai4trade points (10 per published signal). Use sparingly — typically only once to verify the round-trip end-to-end.

## File map

| File | Purpose |
|---|---|
| [`transform.ts`](./transform.ts) | Pure mapper: `toAi4tradeRequest(signal): Ai4tradeRequest \| null`. No I/O. |
| [`run.ts`](./run.ts) | End-to-end demo: MCP fetch → reshape → transform → log or POST. Env-gated live mode. |
| [`tests/transform.test.ts`](./tests/transform.test.ts) | Vitest unit tests (9 cases incl. HOLD-skip, missing-quantity-defaults, structural validation). |
| `README.md` | This file. |

## Mapping rules

| Verifiable-Signal v1.0 field | ai4trade field | Note |
|---|---|---|
| `market` | `market` | 1:1 passthrough |
| `action` | `action` | Pass `buy`/`sell` through; `hold` → return `null` (skip); unknown → throw |
| `symbol` | `symbol` | 1:1 passthrough |
| `price` | `price` | Defaults to `0` (ai4trade treats `0` as "auto-query current price") |
| `quantity` | `quantity` | Defaults to `0` ("informational signal, no position size implied") |
| `composite_verdict` | `content` | Formatted: `AlgoVault verdict: {verdict} \| confidence {pct}% \| Merkle: {url\|pending}` |
| `executed_at` | `executed_at` | ISO 8601 passthrough; `null` → literal `"now"` (delegates to ai4trade auto-time) |

## Tested against

- `ai4trade.ai/SKILL.md` `POST /api/signals/realtime` schema as of **2026-05-22**.
- AlgoVault MCP `crypto-quant-signal-mcp@1.17.0` at `https://api.algovault.com/mcp`.
- Verifiable-Signal v1.0 spec at [`docs/INTEROP-SPEC-v1.md`](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md).

Re-verify if either upstream drifts.

## License

MIT — see [LICENSE](../../LICENSE) at repo root.
