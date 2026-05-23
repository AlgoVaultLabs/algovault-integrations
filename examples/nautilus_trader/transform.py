"""
examples/nautilus_trader/transform.py

Pure transformer: AlgoVault Verifiable-Signal v1.0 envelope -> AlgoVaultSignal
(a nautilus_trader Data subclass ready to publish onto the DataEngine bus).

Mirrors the locked-in factory shape from G2-W1 (`toAi4tradeRequest(signal) -> Ai4tradeRequest | null`):
    to_nautilus_signal(signal: VerifiableSignalV1) -> AlgoVaultSignal | None

HOLD verdicts return None (skip publish; HOLDs are noise in a decision loop).
Unknown verdicts raise ValueError with the signal_id embedded for traceability.

Contract:
- No I/O, no network, no env reads. Input in, output out, deterministic.
- AlgoVaultSignal carries the v1.0 fields agents need: signal_id, market, action,
  symbol, price, quantity, confidence, verdict, merkle_anchor_url,
  venues_consulted, ts_event, ts_init.
- ts_event derives from vs.executed_at (ISO-8601 -> nanoseconds since epoch).
  When vs.executed_at is None, ts_event defaults to current UTC nanoseconds.
- ts_init is set to the local time-of-construction (Nautilus convention).

References:
- AlgoVault Verifiable-Signal Interop Spec v1.0:
    https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md
- JSON Schema $id (canonical SoT):
    https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/schemas/verifiable-signal-v1.json
- Nautilus Trader `Data` base class:
    https://nautilustrader.io/docs/latest/concepts/data/
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TypedDict, Optional

from nautilus_trader.core.data import Data


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


# ---- AlgoVaultSignal: Nautilus Data subclass ----


class AlgoVaultSignal(Data):
    """A Nautilus `Data` subclass carrying a Verifiable-Signal v1.0 payload.

    Constructed exclusively via `to_nautilus_signal()` from a v1.0 envelope.
    HOLD verdicts never reach this constructor (filtered upstream).

    All fields are immutable after construction (read via properties).
    `venues_consulted` is a tuple to honor Nautilus's Data-immutability convention.
    `ts_event` and `ts_init` are nanoseconds since UTC epoch (Nautilus convention).
    """

    def __init__(
        self,
        signal_id: str,
        market: str,
        action: str,
        symbol: str,
        price: float,
        quantity: float,
        confidence: float,
        verdict: str,
        merkle_anchor_url: Optional[str],
        venues_consulted: tuple[str, ...],
        ts_event: int,
        ts_init: int,
    ) -> None:
        super().__init__()
        self._signal_id = signal_id
        self._market = market
        self._action = action
        self._symbol = symbol
        self._price = float(price)
        self._quantity = float(quantity)
        self._confidence = float(confidence)
        self._verdict = verdict
        self._merkle_anchor_url = merkle_anchor_url
        self._venues_consulted = tuple(venues_consulted)
        self._ts_event = int(ts_event)
        self._ts_init = int(ts_init)

    @property
    def signal_id(self) -> str:
        return self._signal_id

    @property
    def market(self) -> str:
        return self._market

    @property
    def action(self) -> str:
        return self._action

    @property
    def symbol(self) -> str:
        return self._symbol

    @property
    def price(self) -> float:
        return self._price

    @property
    def quantity(self) -> float:
        return self._quantity

    @property
    def confidence(self) -> float:
        return self._confidence

    @property
    def verdict(self) -> str:
        return self._verdict

    @property
    def merkle_anchor_url(self) -> Optional[str]:
        return self._merkle_anchor_url

    @property
    def venues_consulted(self) -> tuple[str, ...]:
        return self._venues_consulted

    @property
    def ts_event(self) -> int:
        return self._ts_event

    @property
    def ts_init(self) -> int:
        return self._ts_init

    def __repr__(self) -> str:
        return (
            f"AlgoVaultSignal(signal_id={self._signal_id!r}, "
            f"symbol={self._symbol!r}, action={self._action!r}, "
            f"confidence={self._confidence}, ts_event={self._ts_event})"
        )


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


def to_nautilus_signal(signal: VerifiableSignalV1) -> Optional[AlgoVaultSignal]:
    """Map a Verifiable-Signal v1.0 envelope to an `AlgoVaultSignal`.

    Returns None when the verdict is `hold` (skip publish; HOLDs are noise).
    Raises ValueError for unknown verdicts, with the `signal_id` embedded.

    Defaults applied per the mapping rules:
    - missing `quantity` -> 0.0 (informational signal)
    - missing `price` -> 0.0
    - missing `merkle_proof` -> `merkle_anchor_url = None`
    - missing `cross_venue_metadata` -> `venues_consulted = ()`
    - missing `executed_at` -> `ts_event = current UTC ns`
    """
    signal_id = str(signal.get("signal_id", ""))
    action = str(signal.get("action", ""))

    if action == "hold":
        return None

    if action not in _PUBLISHABLE_VERDICTS:
        raise ValueError(
            f"to_nautilus_signal: unknown verdict '{action}' in signal.action; "
            f"expected one of: hold, buy, sell, short, cover "
            f"(signal_id={signal_id!r})"
        )

    composite = signal.get("composite_verdict") or {}
    confidence = float(composite.get("confidence", 0.0))
    verdict = str(composite.get("verdict", action))

    price_raw = signal.get("price")
    price = float(price_raw) if price_raw is not None else 0.0

    quantity_raw = signal.get("quantity")
    quantity = float(quantity_raw) if quantity_raw is not None else 0.0

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
        ts_event = _now_ns()
    else:
        ts_event = _iso_to_ns(str(executed_at))

    ts_init = _now_ns()

    return AlgoVaultSignal(
        signal_id=signal_id,
        market=str(signal.get("market", "")),
        action=action,
        symbol=str(signal.get("symbol", "")),
        price=price,
        quantity=quantity,
        confidence=confidence,
        verdict=verdict,
        merkle_anchor_url=merkle_anchor_url,
        venues_consulted=venues_consulted,
        ts_event=ts_event,
        ts_init=ts_init,
    )
