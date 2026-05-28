"""
examples/hummingbot/transform.py

Pure transformer: AlgoVault Verifiable-Signal v1.0 envelope -> HummingbotSignal
(a TypedDict mirroring the OrderCandidate field shape used by Hummingbot
StrategyV2Base scripts).

Mirrors the locked-in factory shape from G2-W1 (`toAi4tradeRequest(signal) -> Ai4tradeRequest | null`):
    to_hummingbot_signal(signal: VerifiableSignalV1) -> HummingbotSignal | None

HOLD verdicts return None (skip publish; HOLDs are noise in a decision loop).
Unknown verdicts raise ValueError with the signal_id embedded for traceability.

Contract:
- No I/O, no network, no env reads, no `from hummingbot.*` imports. Input in,
  output out, deterministic. CI installs zero Hummingbot bytes.
- HummingbotSignal carries the v1.0 fields agents need plus the OrderCandidate-
  shaped keys (trading_pair, order_side, order_type, amount, price) that a
  StrategyV2Base script feeds into `OrderCandidate(**signal)`.
- ts_event_ns derives from vs.executed_at (ISO-8601 -> nanoseconds since epoch).
  When vs.executed_at is None, ts_event_ns defaults to current UTC nanoseconds.

References:
- AlgoVault Verifiable-Signal Interop Spec v1.0:
    https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md
- JSON Schema $id (canonical SoT):
    https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/schemas/verifiable-signal-v1.json
- Hummingbot project home:
    https://hummingbot.org/
- Hummingbot TradeType + OrderType enums:
    https://github.com/hummingbot/hummingbot/blob/master/hummingbot/core/data_type/common.py
- Hummingbot OrderCandidate dataclass:
    https://github.com/hummingbot/hummingbot/blob/master/hummingbot/core/data_type/order_candidate.py
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


# ---- HummingbotSignal: pure TypedDict mirroring OrderCandidate shape ----


class HummingbotSignal(TypedDict):
    """A TypedDict whose first five keys mirror `OrderCandidate` constructor
    args in `hummingbot.core.data_type.order_candidate`.

    A real StrategyV2Base script consumes this dict by passing the relevant
    fields into `OrderCandidate(...)` (see README.md "Plugging into a real
    Hummingbot StrategyV2Base script").

    No `from hummingbot.*` import here — the dict is portable to any consumer
    that wants to read the OrderCandidate-shaped fields without paying the
    Hummingbot install cost.
    """

    trading_pair: str        # "BTC-USDT" — Hummingbot convention via combine_to_hb_trading_pair
    order_side: str          # "BUY" | "SELL" — mirrors hummingbot.core.data_type.common.TradeType enum names
    order_type: str          # "MARKET" | "LIMIT" — mirrors OrderType enum names
    amount: float            # quantity (strategy decides via BudgetChecker; this is informational)
    price: Optional[float]   # required for LIMIT; informational for MARKET
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


def to_hummingbot_signal(signal: VerifiableSignalV1) -> Optional[HummingbotSignal]:
    """Map a Verifiable-Signal v1.0 envelope to a `HummingbotSignal` TypedDict.

    Returns None when the verdict is `hold` (skip publish; HOLDs are noise).
    Raises ValueError for unknown verdicts, with the `signal_id` embedded.

    Verdict -> order_side mapping:
    - `buy`   -> "BUY"
    - `sell`  -> "SELL"
    - `short` -> "SELL"  (open a short = sell)
    - `cover` -> "BUY"   (close a short = buy back)

    Other mapping rules:
    - trading_pair = f"{signal['symbol']}-USDT" (hardcoded "-USDT" for this
      example; real strategies pass the quote via Strategy config).
    - order_type = "MARKET" always (LIMIT support deferred; would need a
      limit-price-offset config the example doesn't model).
    - missing `quantity` -> 0.0 (informational signal).
    - missing `price` -> None (informational for MARKET orders).
    - missing `merkle_proof` -> `merkle_anchor_url = None`.
    - missing `cross_venue_metadata` -> `venues_consulted = ()`.
    - missing `executed_at` -> `ts_event_ns = current UTC ns`.
    """
    signal_id = str(signal.get("signal_id", ""))
    action = str(signal.get("action", ""))

    if action == "hold":
        return None

    if action not in _PUBLISHABLE_VERDICTS:
        raise ValueError(
            f"to_hummingbot_signal: unknown verdict '{action}' in signal.action; "
            f"expected one of: hold, buy, sell, short, cover "
            f"(signal_id={signal_id!r})"
        )

    # Verdict -> Hummingbot TradeType-enum-name mapping.
    # short opens a short position (sell); cover closes a short (buy back).
    if action == "buy" or action == "cover":
        order_side = "BUY"
    else:  # action in {"sell", "short"}
        order_side = "SELL"

    composite = signal.get("composite_verdict") or {}
    confidence = float(composite.get("confidence", 0.0))
    verdict = str(composite.get("verdict", action))

    price_raw = signal.get("price")
    price: Optional[float] = float(price_raw) if price_raw is not None else None

    quantity_raw = signal.get("quantity")
    amount = float(quantity_raw) if quantity_raw is not None else 0.0

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
    trading_pair = f"{symbol}-USDT"

    out: HummingbotSignal = {
        "trading_pair": trading_pair,
        "order_side": order_side,
        "order_type": "MARKET",
        "amount": amount,
        "price": price,
        "signal_id": signal_id,
        "confidence": confidence,
        "verdict": verdict,
        "merkle_anchor_url": merkle_anchor_url,
        "venues_consulted": venues_consulted,
        "ts_event_ns": ts_event_ns,
    }
    return out
