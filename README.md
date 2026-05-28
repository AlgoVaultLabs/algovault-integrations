# algovault-integrations

Production-ready examples for consuming the [AlgoVault Verifiable-Signal v1.0 spec](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md) across downstream execution platforms. Each `examples/<platform>/` directory is a self-contained transformer + demo for one consumer platform.

## Spec references

- **Specification:** [`docs/INTEROP-SPEC-v1.md`](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md)
- **JSON Schema:** [`schemas/verifiable-signal-v1.json`](https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/schemas/verifiable-signal-v1.json)
- **Reference emitter:** AlgoVault MCP at `https://api.algovault.com/mcp` (tool: `get_trade_call`)

## Examples

Most examples ship as **transform code** (`transform.ts` / `transform.py` + tests + `run.ts` / `run.py`). Some platforms (those that are themselves MCP servers, or otherwise don't accept signal-input outbound) ship as **reference-architecture documentation** instead — a single emitter-neutral `README.md` documenting the cross-MCP orchestration pattern, with no transform code.

| Platform | Folder | Transformer signature | Transport |
|---|---|---|---|
| [AI-Trader (ai4trade.ai)](https://ai4trade.ai) | [`examples/ai4trade/`](./examples/ai4trade/) | `toAi4tradeRequest(signal): Ai4tradeRequest \| null` | REST `POST /api/signals/realtime` |
| [Nautilus Trader](https://nautilustrader.io) | [`examples/nautilus_trader/`](./examples/nautilus_trader/) | `to_nautilus_signal(signal) -> AlgoVaultSignal \| None` | Python in-process `AlgoVaultSignal(Data)` publish |
| [3Commas](https://3commas.io) | [`examples/3commas/`](./examples/3commas/) | `makeToThreeCommasRequest(config)` → `(signal) => ThreeCommasRequest \| null` | REST POST Signal Bot custom-signal webhook |
| [QuantDinger](https://github.com/brokermr810/QuantDinger) | [`examples/quantdinger/`](./examples/quantdinger/) | (reference-architecture doc) | IDE-mediated cross-MCP orchestration |
| [Cryptohopper](https://www.cryptohopper.com) | [`examples/cryptohopper/`](./examples/cryptohopper/) | `makeToCryptohopperRequest(config)` → `(signal) => CryptohopperRequest \| null` | REST GET external-Signaler endpoint with HMAC-sha512 `X-Hub-Signature` |
| [Hummingbot](https://hummingbot.org) | [`examples/hummingbot/`](./examples/hummingbot/) | `to_hummingbot_signal(signal) -> HummingbotSignal \| None` | Python in-process TypedDict → `OrderCandidate(**signal)` for `StrategyV2Base` |
| [FreqTrade](https://www.freqtrade.io) | [`examples/freqtrade/`](./examples/freqtrade/) | `to_freqtrade_signal(signal) -> FreqtradeSignal \| None` | Python in-process TypedDict → `IStrategy.populate_entry_trend()` DataFrame flags |

Examples are listed as they ship. Each transform-code example follows the same shape: a pure `toXRequest(signal)` transformer, unit tests, an end-to-end `run` demo, and a terse README. Reference-architecture-doc examples ship a single `README.md` with no transform code.

## Quick start

```bash
gh repo clone AlgoVaultLabs/algovault-integrations
cd algovault-integrations
npm install
npm test
```

`npm test` runs the transformer unit tests across all examples with zero network calls. See each example's README for the optional end-to-end demo.

## Layout

```
algovault-integrations/
├── README.md
├── LICENSE
├── package.json                          # devDeps only
├── tsconfig.json                         # strict ES2022 NodeNext
├── .github/workflows/ci.yml              # vitest across all examples
├── shared/                               # TS primitives (interfaces + helpers) shared across examples
│   ├── types/verifiable-signal-v1.ts     # canonical VerifiableSignalV1 interface
│   └── lib/reshape-to-envelope.ts        # canonical raw-MCP → v1.0-envelope reshape helper
└── examples/
    └── <platform>/
        ├── README.md                     # prereq + run command
        ├── transform.ts                  # pure mapper: VS v1.0 → platform request
        ├── run.ts                        # demo: MCP fetch → transform → log POST
        └── tests/
            └── transform.test.ts         # vitest: mapper output structural validation
```

`shared/` is internal to this mono-repo (NOT npm-published). Per-platform examples import via relative paths (`../../shared/types/...`, `../../shared/lib/...`) per NodeNext ESM convention.

## License

MIT — see [LICENSE](./LICENSE).
