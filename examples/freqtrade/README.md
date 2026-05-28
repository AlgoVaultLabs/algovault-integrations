# examples/freqtrade

Transform AlgoVault Verifiable-Signal v1.0 envelopes into [FreqTrade](https://www.freqtrade.io/en/stable/strategy-customization/) `IStrategy` entry/exit flags (`enter_long`, `enter_short`, `exit_long`, `exit_short`), ready to write onto the DataFrame your `populate_entry_trend` / `populate_exit_trend` override receives. HOLD verdicts return `None` so HOLDs never flip a DataFrame flag.

## Prerequisites

1. Python 3.11+ (FreqTrade 2026.4 requires `>=3.11`).
2. Clone + install (editable, with dev deps):
   ```bash
   gh repo clone AlgoVaultLabs/algovault-integrations
   cd algovault-integrations/examples/freqtrade
   pip install -e .[dev]
   ```
   Or with [uv](https://docs.astral.sh/uv/):
   ```bash
   uv venv --python 3.11 .venv && source .venv/bin/activate
   uv pip install -e .[dev]
   ```

## Run the tests

```bash
cd examples/freqtrade
pytest tests/ -v
```

Runs the 12 pytest cases against `transform.py`. Inline-fixture tests; zero network; zero `freqtrade` import. Same path runs in CI on every push.

## Run the demo

```bash
python examples/freqtrade/run.py
```

Connects to `https://api.algovault.com/mcp`, calls `get_trade_call(coin="BTC", timeframe="5m", includeReasoning=True, exchange="BINANCE")`, reshapes the response into a Verifiable-Signal v1.0 envelope, applies `to_freqtrade_signal`, and logs the would-be IStrategy receipt. HOLD verdicts log `skipping FreqTrade publish per transform contract` and exit 0. The full IStrategy + DataFrame + indicator wiring is sketched inline in `run.py`'s module docstring; the demo plays the role of a `populate_entry_trend` / `populate_exit_trend` override without booting the full FreqTrade venue infrastructure.

## File map

| File | Purpose |
|---|---|
| [`transform.py`](./transform.py) | Pure mapper: `to_freqtrade_signal(signal) -> FreqtradeSignal \| None` + `FreqtradeSignal` TypedDict. No I/O, no `freqtrade` import. |
| [`run.py`](./run.py) | End-to-end demo: MCP fetch via the `mcp` Python SDK + reshape + transform + log. |
| [`tests/test_transform.py`](./tests/test_transform.py) | Pytest unit tests (12 cases incl. HOLD-skip, missing-quantity, structural validation, FreqTrade pair format, short/cover flag exclusivity). |
| [`pyproject.toml`](./pyproject.toml) | Project metadata + pinned deps. |
| `README.md` | This file. |

## Mapping rules

Verifiable-Signal v1.0 field -> `FreqtradeSignal` field:

| v1.0 envelope field | FreqtradeSignal field | Notes |
|---|---|---|
| `symbol` | `pair: str` | Suffixed with `/USDT` per FreqTrade slash convention (`BTC` -> `"BTC/USDT"`). |
| `action` ("buy") | `enter_long: bool` | True only for `buy`; otherwise False. |
| `action` ("sell", "short") | `enter_short: bool` | True for `sell` or `short`; otherwise False. |
| (none) | `exit_long: bool` | Always False; v1.0 has no exit-from-long verdict, so a strategy that owns long inventory consumes `sell` as exit_long at the consumer layer. |
| `action` ("cover") | `exit_short: bool` | True only for `cover`; otherwise False. |
| `composite_verdict.confidence` | `enter_tag` / `exit_tag` | Debug label `"algovault-<verdict>-<conf>"` (e.g. `"algovault-buy-0.78"`); the inactive tag is `None`. |
| `signal_id` | `signal_id: str` | UUID-shaped; required. |
| `composite_verdict.confidence` | `confidence: float` | `[0.0, 1.0]` range per v1.0 schema. |
| `composite_verdict.verdict` | `verdict: str` | Synced with `action` for v1.0; future versions may diverge. |
| `merkle_proof.anchor_url` | `merkle_anchor_url: str \| None` | `None` when not yet on-chain. |
| `cross_venue_metadata.venues_consulted` | `venues_consulted: tuple[str, ...]` | Immutable tuple. |
| `executed_at` | `ts_event_ns: int` (ns) | Parses ISO-8601 to UTC ns; falls back to current UTC ns when `None`. |
| `quantity` | (intentionally absent) | FreqTrade decides position size at the strategy layer via `stake_amount` / `custom_stake_amount`, not via signal-side quantity. |

## Plugging into a real FreqTrade IStrategy

`FreqtradeSignal` mirrors the 4-flag DataFrame contract that `populate_entry_trend` / `populate_exit_trend` write to. A minimal IStrategy override that consumes this transformer:

```python
from freqtrade.strategy import IStrategy
import pandas as pd

from transform import to_freqtrade_signal

class AlgoVaultStrategy(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "5m"
    stoploss = -0.10
    can_short = True

    def populate_entry_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        envelope = fetch_algovault_envelope(metadata["pair"], self.timeframe)
        sig = to_freqtrade_signal(envelope)
        if sig is None or sig["pair"] != metadata["pair"]:
            return dataframe
        if sig["enter_long"]:
            dataframe.loc[dataframe.index[-1:], ["enter_long","enter_tag"]] = (1, sig["enter_tag"])
        if sig["enter_short"]:
            dataframe.loc[dataframe.index[-1:], ["enter_short","enter_tag"]] = (1, sig["enter_tag"])
        return dataframe

    def populate_exit_trend(self, dataframe: pd.DataFrame, metadata: dict) -> pd.DataFrame:
        envelope = fetch_algovault_envelope(metadata["pair"], self.timeframe)
        sig = to_freqtrade_signal(envelope)
        if sig is None or sig["pair"] != metadata["pair"]:
            return dataframe
        if sig["exit_long"]:
            dataframe.loc[dataframe.index[-1:], ["exit_long","exit_tag"]] = (1, sig["exit_tag"])
        if sig["exit_short"]:
            dataframe.loc[dataframe.index[-1:], ["exit_short","exit_tag"]] = (1, sig["exit_tag"])
        return dataframe
```

See [the FreqTrade strategy customization docs](https://www.freqtrade.io/en/stable/strategy-customization/) for the full `IStrategy` + DataFrame + indicator wiring (`INTERFACE_VERSION=3` is the current contract as of FreqTrade 2026.4).

## Why no runtime `freqtrade` dep?

`transform.py` is pure: it consumes a v1.0 envelope dict and returns a `FreqtradeSignal` TypedDict. The 4-flag shape mirrors what an `IStrategy` override writes onto its DataFrame, but the transformer does not import `freqtrade.strategy.IStrategy`. This keeps the example installable in seconds (no `pandas` + `ccxt` + `ta-lib` chain), keeps CI fast, and lets a downstream strategy author wire `to_freqtrade_signal` into their own `IStrategy` subclass without inheriting our test-time deps. The `IStrategy` integration is documented (above) for copy-paste rather than imported.

## Verdict-handling contract

- `hold` -> returns `None` (skip publish; HOLDs never flip a DataFrame flag).
- `buy` -> `enter_long = True`; tag `"algovault-buy-<conf>"`.
- `sell` -> `enter_short = True`; tag `"algovault-sell-<conf>"`. (v1.0 has no current-position field; a strategy that owns long inventory interprets `sell` as `exit_long` at the consumer layer.)
- `short` -> `enter_short = True`; tag `"algovault-short-<conf>"`.
- `cover` -> `exit_short = True`; tag `"algovault-cover-<conf>"`.
- Any other value (e.g. `"long"`, `"exit"`) -> raises `ValueError` with `signal_id` embedded for traceability.

Exactly ONE of the four flags is `True` per non-HOLD output; the other three are `False`.

## Tested against

- `freqtrade 2026.4` (`INTERFACE_VERSION=3`, populate_entry_trend / populate_exit_trend).
- `mcp 1.27.1` (official Python SDK).
- AlgoVault MCP `crypto-quant-signal-mcp@1.17.0` at `https://api.algovault.com/mcp`.
- Verifiable-Signal v1.0 spec at commit [`06d76e3`](https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md).

Re-verify if any upstream drifts.

## License + FreqTrade GPL-3.0 note

This example is MIT-licensed (matching the mono-repo). FreqTrade is [GPL-3.0](https://github.com/freqtrade/freqtrade/blob/develop/LICENSE); consumers who redistribute FreqTrade-linked binaries must comply with GPL terms. The transformer itself imports no `freqtrade.*` symbols (the `IStrategy` integration sketch is plain documentation), so this example can be vendored, forked, or copy-pasted under MIT terms without inheriting GPL obligations. Downstream redistribution decisions — particularly bundling a FreqTrade strategy that calls `to_freqtrade_signal` — remain downstream's to evaluate against GPL's library-link interpretation.

See [LICENSE](../../LICENSE) at the mono-repo root.
