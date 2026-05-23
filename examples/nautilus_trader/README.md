# examples/nautilus_trader

Transform AlgoVault Verifiable-Signal v1.0 envelopes into [Nautilus Trader](https://nautilustrader.io) `AlgoVaultSignal(Data)` instances, ready to publish onto an in-process `DataEngine` bus and consume from any `Strategy.on_data` handler. HOLD verdicts are skipped (the transformer returns `None`) so HOLDs never reach a Strategy's decision loop.

## Prerequisites

1. Python 3.12-3.14 (Nautilus 1.227.0 requires `>=3.12,<3.15`).
2. Clone + install (editable, with dev deps):
   ```bash
   gh repo clone AlgoVaultLabs/algovault-integrations
   cd algovault-integrations/examples/nautilus_trader
   pip install -e .[dev]
   ```
   Or with [uv](https://docs.astral.sh/uv/):
   ```bash
   uv venv --python 3.12 .venv && source .venv/bin/activate
   uv pip install -e .[dev]
   ```

## Run the tests

```bash
cd examples/nautilus_trader
pytest tests/ -v
```

Runs the 10 pytest cases against `transform.py`. Inline-fixture tests; zero network. Same path runs in CI on every push.

## Run the demo

```bash
python examples/nautilus_trader/run.py
```

Connects to `https://api.algovault.com/mcp`, calls `get_trade_call(coin="BTC", timeframe="5m", includeReasoning=True, exchange="BINANCE")`, reshapes the response into a Verifiable-Signal v1.0 envelope, applies `to_nautilus_signal`, and logs the would-be Strategy receipt. HOLD verdicts log `skipping Nautilus publish per transform contract` and exit 0. The full Nautilus DataEngine + MessageBus + Strategy wiring is sketched inline in `run.py`'s `_publish_to_nautilus_bus` docstring; the demo plays the role of an `on_data` handler without booting the full venue infrastructure.

## File map

| File | Purpose |
|---|---|
| [`transform.py`](./transform.py) | Pure mapper: `to_nautilus_signal(signal) -> AlgoVaultSignal \| None` + `AlgoVaultSignal(Data)` class. No I/O. |
| [`run.py`](./run.py) | End-to-end demo: MCP fetch via the `mcp` Python SDK + reshape + transform + log. |
| [`tests/test_transform.py`](./tests/test_transform.py) | Pytest unit tests (10 cases incl. HOLD-skip, missing-quantity-defaults, structural validation). |
| [`pyproject.toml`](./pyproject.toml) | Project metadata + pinned deps. |
| `README.md` | This file. |

## Mapping rules

Verifiable-Signal v1.0 field -> `AlgoVaultSignal` field:

| v1.0 envelope field | AlgoVaultSignal field | Notes |
|---|---|---|
| `signal_id` | `signal_id: str` | UUID-shaped; required. |
| `market` | `market: str` | e.g. `"crypto"`; required. |
| `action` | `action: str` | `"buy"` / `"sell"`; HOLD already filtered. |
| `symbol` | `symbol: str` | e.g. `"BTC"`; required. |
| `price` | `price: float` | Defaults to `0.0` when absent. |
| `quantity` | `quantity: float` | Defaults to `0.0` ("informational signal, no position size implied"). |
| `composite_verdict.confidence` | `confidence: float` | `[0.0, 1.0]` range per v1.0 schema. |
| `composite_verdict.verdict` | `verdict: str` | Synced with `action` for v1.0; future versions may diverge. |
| `merkle_proof.anchor_url` | `merkle_anchor_url: str \| None` | `None` when not yet on-chain. |
| `cross_venue_metadata.venues_consulted` | `venues_consulted: tuple[str, ...]` | Immutable tuple per Nautilus convention. |
| `executed_at` | `ts_event: int` (ns) | Parses ISO-8601 to UTC ns; falls back to current UTC ns when `None`. |
| (local time-of-init) | `ts_init: int` (ns) | Set to current UTC ns at construction. |

### Verdict-handling contract

- `hold` -> returns `None` (skip publish; HOLDs never reach a Strategy).
- `buy`, `sell`, `short`, `cover` -> instantiates `AlgoVaultSignal`.
- Any other value (e.g. `"long"`, `"exit"`) -> raises `ValueError` with `signal_id` embedded for traceability.

## Tested against

- `nautilus_trader 1.227.0` (PyPI, requires Python `>=3.12,<3.15`).
- `mcp 1.27.1` (official Python SDK).
- AlgoVault MCP `crypto-quant-signal-mcp@1.17.0` at `https://api.algovault.com/mcp`.
- Verifiable-Signal v1.0 spec at commit [`06d76e3`](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md).

Re-verify if any upstream drifts.

## License + Nautilus LGPL-3.0 note

This example is MIT-licensed (matching the mono-repo). Nautilus Trader is [LGPL-3.0](https://github.com/nautechsystems/nautilus_trader/blob/master/LICENSE); this example uses it as a runtime dependency (library exception applies). Downstream redistribution implications — particularly for closed-source bundlers — are downstream's to evaluate.

See [LICENSE](../../LICENSE) at the mono-repo root.
