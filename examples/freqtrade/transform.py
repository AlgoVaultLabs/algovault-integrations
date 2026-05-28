"""
examples/freqtrade/transform.py

Pure transformer: AlgoVault Verifiable-Signal v1.0 envelope -> FreqtradeSignal
(a TypedDict carrying the canonical 4-flag entry/exit shape that a real
FreqTrade `IStrategy.populate_entry_trend` / `populate_exit_trend` override
writes onto its DataFrame).

Mirrors the locked-in factory shape from G2-W1 (`toAi4tradeRequest(signal) -> Ai4tradeRequest | null`):
    to_freqtrade_signal(signal: VerifiableSignalV1) -> FreqtradeSignal | None

HOLD verdicts return None (skip publish; HOLDs are noise in a decision loop and
should never flip entry/exit flags on a DataFrame).
Unknown verdicts raise ValueError with the signal_id embedded for traceability.

Contract:
- No I/O, no network, no env reads. Input in, output out, deterministic.
- No `from freqtrade.*` imports. The transformer is pure and tests pass without
  freqtrade installed. The 4-flag shape mirrors what the FreqTrade IStrategy
  hook expects to write onto its DataFrame; pairing with a real strategy is
  documented in `run.py` and `README.md`.
- FreqtradeSignal carries: pair, enter_long, enter_short, exit_long, exit_short,
  enter_tag, exit_tag, signal_id, confidence, verdict, merkle_anchor_url,
  venues_consulted, ts_event_ns.
- `pair` follows FreqTrade's slash convention ("BTC/USDT", "ETH/USDT").
- `ts_event_ns` derives from vs.executed_at (ISO-8601 -> nanoseconds since epoch).
  When vs.executed_at is None, ts_event_ns defaults to current UTC nanoseconds.

References:
- AlgoVault Verifiable-Signal Interop Spec v1.0:
    https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md
- JSON Schema $id (canonical SoT):
    https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/schemas/verifiable-signal-v1.json
- FreqTrade IStrategy customization (INTERFACE_VERSION=3, populate_entry_trend,
  populate_exit_trend, enter_long/enter_short/exit_long/exit_short DataFrame flags):
    https://www.freqtrade.io/en/stable/strategy-customization/
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TypedDict, Optional


# ---- Verifiable-Signal v1.0 (Python TypedDict mirror; subset used by this transform) ----


class CompositeVerdict(TypedDict, total=False):
    verdict: str
    confidence: float
    factor_weights: dict[str, float]


class MerkleProof(TypedDict, total=False):
    leaf: str
    root: str
    path: list[dict]
    hash_algo: str
    published_at: Optional[str]
    anchor_url: Optional[str]


class CrossVenueMetadata(TypedDict, total=False):
    venues_consulted: list[str]
    venue_agreement_score: Optional[float]
    per_venue_verdicts: dict[str, str]


class VerifiableSignalV1(TypedDict, total=False):
    """Verifiable-Signal v1.0 envelope per the canonical schema.

    Hand-written per Plan-Mode Q-A precedent (G2-W1): defer codegen until
    >=3 Python examples share the type.
    """

    version: str
    signal_id: str
    emitted_at: str
    market: str
    action: str
    symbol: str
    price: Optional[float]
    quantity: Optional[float]
    timeframe: str
    executed_at: Optional[str]
    content: Optional[str]
    composite_verdict: CompositeVerdict
    merkle_proof: Optional[MerkleProof]
    cross_venue_metadata: Optional[CrossVenueMetadata]


# ---- FreqtradeSignal: TypedDict mirror of the IStrategy 4-flag shape ----


class FreqtradeSignal(TypedDict):
    """A TypedDict carrying the data a FreqTrade IStrategy override needs to
    flip entry/exit flags on its DataFrame.

    Constructed exclusively via `to_freqtrade_signal()` from a v1.0 envelope.
    HOLD verdicts never reach this constructor (filtered upstream).

    Exactly ONE of the four boolean flags is True per non-HOLD envelope; the
    other three are False. The verdict mapping is:
        buy   -> enter_long  = True
        sell  -> enter_short = True
        short -> enter_short = True
        cover -> exit_short  = True

    Note: SELL maps to enter_short rather than exit_long because the v1.0
    envelope does NOT carry a current-position field, so "sell" is treated
    as "open a short" (the only side-flat -> side-active transition that
    fits a flat decision loop). A real strategy that owns long inventory
    interprets "sell" as exit_long at the consumer layer.
    """

    pair: str  # FreqTrade convention: slash-separated, e.g. "BTC/USDT"
    enter_long: bool
    enter_short: bool
    exit_long: bool
    exit_short: bool
    enter_tag: Optional[str]  # debug label for entry signal
    exit_tag: Optional[str]
    signal_id: str
    confidence: float
    verdict: str
    merkle_anchor_url: Optional[str]
    venues_consulted: tuple[str, ...]
    ts_event_ns: int


# ---- Transformer ----


_PUBLISHABLE_VERDICTS = frozenset({"buy", "sell", "short", "cover"})


def _iso_to_ns(iso_string: str) -> int:
    """Parse an ISO-8601 UTC timestamp into nanoseconds since the Unix epoch.

    Accepts both `...Z` and `...+00:00` suffix forms.
    """
    # datetime.fromisoformat handles "...+00:00" natively; convert "Z" first.
    normalized = iso_string.replace("Z", "+00:00")
    dt = datetime.fromisoformat(normalized)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    seconds = dt.timestamp()
    return int(seconds * 1_000_000_000)


def _now_ns() -> int:
    """Current UTC time as nanoseconds since the Unix epoch."""
    return int(datetime.now(tz=timezone.utc).timestamp() * 1_000_000_000)


def to_freqtrade_signal(signal: VerifiableSignalV1) -> Optional[FreqtradeSignal]:
    """Map a Verifiable-Signal v1.0 envelope to a `FreqtradeSignal`.

    Returns None when the verdict is `hold` (skip publish; HOLDs are noise).
    Raises ValueError for unknown verdicts, with the `signal_id` embedded.

    Verdict mapping (exactly ONE of the four flags is True per output):
        buy   -> enter_long  = True ; enter_tag = "algovault-buy-<conf>"
        sell  -> enter_short = True ; enter_tag = "algovault-sell-<conf>"
        short -> enter_short = True ; enter_tag = "algovault-short-<conf>"
        cover -> exit_short  = True ; exit_tag  = "algovault-cover-<conf>"

    Defaults applied per the mapping rules:
    - `pair` = f"{symbol}/USDT" (FreqTrade slash convention; v1.0 ships base
      symbol only, USDT is the canonical AlgoVault quote)
    - missing `merkle_proof` -> `merkle_anchor_url = None`
    - missing `cross_venue_metadata` -> `venues_consulted = ()`
    - missing `executed_at` -> `ts_event_ns = current UTC ns`
    - `quantity` is intentionally NOT projected: FreqTrade decides position
      size at the strategy layer via `stake_amount` / `custom_stake_amount`,
      not via signal-side quantity.
    """
    signal_id = str(signal.get("signal_id", ""))
    action = str(signal.get("action", ""))

    if action == "hold":
        return None

    if action not in _PUBLISHABLE_VERDICTS:
        raise ValueError(
            f"to_freqtrade_signal: unknown verdict '{action}' in signal.action; "
            f"expected one of: hold, buy, sell, short, cover "
            f"(signal_id={signal_id!r})"
        )

    composite = signal.get("composite_verdict") or {}
    confidence = float(composite.get("confidence", 0.0))
    verdict = str(composite.get("verdict", action))

    merkle = signal.get("merkle_proof")
    merkle_anchor_url: Optional[str] = None
    if merkle is not None:
        anchor = merkle.get("anchor_url")
        if anchor is not None and anchor != "":
            merkle_anchor_url = str(anchor)

    cross_venue = signal.get("cross_venue_metadata")
    venues_consulted: tuple[str, ...] = ()
    if cross_venue is not None:
        raw_venues = cross_venue.get("venues_consulted") or []
        venues_consulted = tuple(str(v) for v in raw_venues)

    executed_at = signal.get("executed_at")
    if executed_at is None or executed_at == "":
        ts_event_ns = _now_ns()
    else:
        ts_event_ns = _iso_to_ns(str(executed_at))

    symbol = str(signal.get("symbol", ""))
    pair = f"{symbol}/USDT"

    # Initialize all four flags False; flip exactly one per verdict.
    enter_long = False
    enter_short = False
    exit_long = False
    exit_short = False
    enter_tag: Optional[str] = None
    exit_tag: Optional[str] = None

    if action == "buy":
        enter_long = True
        enter_tag = f"algovault-buy-{confidence:.2f}"
    elif action == "sell":
        enter_short = True
        enter_tag = f"algovault-sell-{confidence:.2f}"
    elif action == "short":
        enter_short = True
        enter_tag = f"algovault-short-{confidence:.2f}"
    elif action == "cover":
        exit_short = True
        exit_tag = f"algovault-cover-{confidence:.2f}"
    # No else: _PUBLISHABLE_VERDICTS gate above guarantees one of the four.

    out: FreqtradeSignal = {
        "pair": pair,
        "enter_long": enter_long,
        "enter_short": enter_short,
        "exit_long": exit_long,
        "exit_short": exit_short,
        "enter_tag": enter_tag,
        "exit_tag": exit_tag,
        "signal_id": signal_id,
        "confidence": confidence,
        "verdict": verdict,
        "merkle_anchor_url": merkle_anchor_url,
        "venues_consulted": venues_consulted,
        "ts_event_ns": ts_event_ns,
    }
    return out
