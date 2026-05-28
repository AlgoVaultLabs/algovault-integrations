# examples/hummingbot

Transform AlgoVault Verifiable-Signal v1.0 envelopes into a `HummingbotSignal` TypedDict shaped to match [Hummingbot](https://hummingbot.org/)'s `OrderCandidate` constructor — ready for a `StrategyV2Base.on_tick` consumer to splat into `OrderCandidate(**signal)` and submit via the connector. The transform itself is pure: no `from hummingbot.*` imports, so the test suite installs zero Hummingbot bytes. HOLD verdicts are skipped (`to_hummingbot_signal` returns `None`) so they never reach the Strategy decision loop.

## Prerequisites

1. Python 3.10.12+ (matches Hummingbot's `requires-python` floor on PyPI).
2. Clone + install (editable, with dev deps):
   ```bash
   gh repo clone AlgoVaultLabs/algovault-integrations
   cd algovault-integrations/examples/hummingbot
   pip install -e .[dev]
   ```
   Or with [uv](https://docs.astral.sh/uv/):
   ```bash
   uv venv --python 3.10 .venv && source .venv/bin/activate
   uv pip install -e .[dev]
   ```

## Run the tests

```bash
cd examples/hummingbot
pytest tests/ -v
```

Runs the 12 pytest cases against `transform.py`. Inline-fixture tests; zero network; zero Hummingbot import. Same path runs in CI on every push.

## Run the demo

```bash
python examples/hummingbot/run.py
```

Connects to `https://api.algovault.com/mcp`, calls `get_trade_call(coin="BTC", timeframe="5m", includeReasoning=True, exchange="BINANCE")`, reshapes the response into a Verifiable-Signal v1.0 envelope, applies `to_hummingbot_signal`, and logs the resulting dict as a Strategy's `on_tick` handler would consume it. HOLD verdicts log `skipping Hummingbot publish per transform contract` and exit 0. The full Hummingbot StrategyV2Base + Connector + BudgetChecker wiring is sketched in `run.py`'s module docstring; this script plays the role of an `on_tick` handler without booting the full venue infrastructure.

## File map

| File | Purpose |
|---|---|
| [`transform.py`](./transform.py) | Pure mapper: `to_hummingbot_signal(signal) -> HummingbotSignal \| None` + `HummingbotSignal` TypedDict. No I/O. No `hummingbot` import. |
| [`run.py`](./run.py) | End-to-end demo: MCP fetch via the `mcp` Python SDK + reshape + transform + log. |
| [`tests/test_transform.py`](./tests/test_transform.py) | Pytest unit tests (12 cases incl. HOLD-skip, missing-quantity-defaults, structural validation, trading-pair format, short/cover verdict mapping). |
| [`pyproject.toml`](./pyproject.toml) | Project metadata + pinned deps. |
| `README.md` | This file. |

## Mapping rules

Verifiable-Signal v1.0 field -> `HummingbotSignal` field:

| v1.0 envelope field | HummingbotSignal field | Notes |
|---|---|---|
| `symbol` | `trading_pair: str` | `f"{symbol}-USDT"` — Hummingbot uses `<base>-<quote>` ([source](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/core/data_type/common.py)). USDT hardcoded for this example; real strategies pass the quote via Strategy config. |
| `action` | `order_side: str` | `"BUY"` / `"SELL"` — mirrors `hummingbot.core.data_type.common.TradeType` enum names. `short` -> `"SELL"` (open short); `cover` -> `"BUY"` (close short). |
| (constant) | `order_type: str` | `"MARKET"` always. LIMIT support deferred (would need a price-offset config the example doesn't model). |
| `quantity` | `amount: float` | Defaults to `0.0` when absent ("informational signal, no position size implied"). |
| `price` | `price: Optional[float]` | `None` when absent. Required for LIMIT; informational for MARKET. |
| `signal_id` | `signal_id: str` | UUID-shaped; required. |
| `composite_verdict.confidence` | `confidence: float` | `[0.0, 1.0]` range per v1.0 schema. |
| `composite_verdict.verdict` | `verdict: str` | Synced with `action` for v1.0; future versions may diverge. |
| `merkle_proof.anchor_url` | `merkle_anchor_url: str \| None` | `None` when not yet on-chain. |
| `cross_venue_metadata.venues_consulted` | `venues_consulted: tuple[str, ...]` | Immutable tuple. |
| `executed_at` | `ts_event_ns: int` | Parses ISO-8601 to UTC ns; falls back to current UTC ns when `None`. |

## Plugging into a real Hummingbot StrategyV2Base script

Splat the dict into `OrderCandidate` and submit via the connector:

```python
from decimal import Decimal
from hummingbot.core.data_type.common import OrderType, TradeType
from hummingbot.core.data_type.order_candidate import OrderCandidate
from hummingbot.strategy_v2.strategy_v2_base import StrategyV2Base

from transform import to_hummingbot_signal


class AlgoVaultStrategy(StrategyV2Base):
    def on_tick(self) -> None:
        envelope = self.fetch_envelope()           # your MCP call + reshape
        sig = to_hummingbot_signal(envelope)
        if sig is None:
            return                                 # HOLD verdict; skip
        if sig["confidence"] < 0.6:
            return                                 # low conviction; skip
        candidate = OrderCandidate(
            trading_pair=sig["trading_pair"],
            is_maker=False,
            order_type=OrderType[sig["order_type"]],
            order_side=TradeType[sig["order_side"]],
            amount=Decimal(str(sig["amount"])),
            price=Decimal(str(sig["price"] or 0)),
        )
        adjusted = self.connectors["binance_paper_trade"].budget_checker.adjust_candidate(
            candidate, all_or_none=False,
        )
        # ... place_order(adjusted) via the connector
```

See [Hummingbot V2 strategy guide](https://hummingbot.org/) for the full Connector + BudgetChecker + place_order wiring.

## Why no runtime hummingbot dep?

`transform.py` mirrors the Hummingbot field shape (`TradeType` / `OrderType` enum names + `OrderCandidate` constructor args) via a `TypedDict` — the same bytes go in, the same bytes come out, but without paying the install cost of the framework (which pulls in `pydantic`, `aiohttp`, exchange connectors, and dozens of other deps). This keeps CI fast and the transformer portable to any consumer that wants the OrderCandidate-shaped dict without running the framework. Real Strategy scripts add the `hummingbot` dep themselves and splat the dict into `OrderCandidate(**signal)` (or pick the keys they need).

## Verdict-handling contract

- `hold` -> returns `None` (skip publish; HOLDs never reach a Strategy).
- `buy`, `sell`, `short`, `cover` -> returns a populated `HummingbotSignal` dict.
- Any other value (e.g. `"long"`, `"exit"`) -> raises `ValueError` with `signal_id` embedded for traceability.

## Tested against

- `hummingbot 20260521` (PyPI; latest stable as of 2026-05-29; `requires-python >=3.10.12`).
- `mcp 1.27.1` (official Python SDK).
- AlgoVault MCP `crypto-quant-signal-mcp@1.17.0` at `https://api.algovault.com/mcp`.
- Verifiable-Signal v1.0 spec at commit [`06d76e3`](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md).

Re-verify if any upstream drifts.

## License + Hummingbot Apache-2.0 note

This example is MIT-licensed (matching the mono-repo). [Hummingbot](https://github.com/hummingbot/hummingbot/blob/master/LICENSE) is Apache-2.0; this example does not import it at runtime (the field names are mirrored in a `TypedDict`), so downstream redistribution carries no additional Apache-2.0 obligation beyond what consumers take on when they add the `hummingbot` dep to their own Strategy package.

See [LICENSE](../../LICENSE) at the mono-repo root.
