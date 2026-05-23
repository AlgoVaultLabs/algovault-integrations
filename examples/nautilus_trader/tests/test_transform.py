"""
examples/nautilus_trader/tests/test_transform.py

Pytest cases at parity with G2-W1's vitest cases for the ai4trade example.

Coverage (7 spec + 2 bonus = 9 cases):
    1. HOLD signal -> to_nautilus_signal returns None
    2. BUY signal -> AlgoVaultSignal instance with action="buy", verdict, confidence
    3. SELL signal -> action="sell" passes through
    4. Unknown verdict ("long") -> raises ValueError with signal_id in message
    5. Missing quantity -> defaults to 0.0
    6. Missing merkle_proof -> merkle_anchor_url is None
    7. Structural validation -> all 12 fields present with expected types
    8. (bonus) Null executed_at -> ts_event defaults to current UTC nanoseconds
    9. (bonus) Populated merkle_proof.anchor_url -> merkle_anchor_url equals it

Zero network. Zero MCP imports. Zero httpx imports. Inline dict fixtures only.

Note: this test file DOES import `nautilus_trader` indirectly via transform.py
(AlgoVaultSignal subclasses nautilus_trader.core.data.Data). CI installs
nautilus_trader as a runtime dep per architect-ratified Plan-Mode Q-B
(honest typing against the real Data class hierarchy).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from transform import (
    AlgoVaultSignal,
    VerifiableSignalV1,
    to_nautilus_signal,
)


# ---- Helpers ----


def base_buy_signal(**overrides: Any) -> dict:
    """Return a fresh base BUY VerifiableSignalV1 dict; override keys as needed."""
    signal: dict = {
        "version": "1.0",
        "signal_id": "test-buy-001",
        "emitted_at": "2026-05-22T16:11:21Z",
        "market": "crypto",
        "action": "buy",
        "symbol": "BTC",
        "price": 76742.4,
        "quantity": 0.1,
        "timeframe": "5m",
        "executed_at": "2026-05-22T16:11:21Z",
        "content": "buy rationale",
        "composite_verdict": {"verdict": "buy", "confidence": 0.78},
        "merkle_proof": None,
        "cross_venue_metadata": None,
    }
    signal.update(overrides)
    return signal


REQUIRED_ALGOVAULT_SIGNAL_FIELDS = (
    "signal_id",
    "market",
    "action",
    "symbol",
    "price",
    "quantity",
    "confidence",
    "verdict",
    "merkle_anchor_url",
    "venues_consulted",
    "ts_event",
    "ts_init",
)


# ---- Tests ----


def test_case_1_hold_signal_returns_none() -> None:
    """HOLD verdict skips publish (returns None)."""
    signal = base_buy_signal(
        action="hold",
        composite_verdict={"verdict": "hold", "confidence": 0.52},
    )
    assert to_nautilus_signal(signal) is None


def test_case_2_buy_signal_produces_full_algovault_signal() -> None:
    """BUY verdict produces AlgoVaultSignal with all required fields."""
    signal = base_buy_signal()
    out = to_nautilus_signal(signal)
    assert isinstance(out, AlgoVaultSignal)
    assert out.action == "buy"
    assert out.verdict == "buy"
    assert out.symbol == "BTC"
    assert out.market == "crypto"
    assert out.price == pytest.approx(76742.4)
    assert out.quantity == pytest.approx(0.1)
    assert out.confidence == pytest.approx(0.78)
    assert out.signal_id == "test-buy-001"
    # ts_event should be derived from executed_at (2026-05-22T16:11:21Z)
    expected_ns = int(
        datetime(2026, 5, 22, 16, 11, 21, tzinfo=timezone.utc).timestamp()
        * 1_000_000_000
    )
    assert out.ts_event == expected_ns


def test_case_3_sell_signal_passes_action_through() -> None:
    """SELL verdict produces AlgoVaultSignal with action='sell'."""
    signal = base_buy_signal(
        action="sell",
        composite_verdict={"verdict": "sell", "confidence": 0.65},
    )
    out = to_nautilus_signal(signal)
    assert isinstance(out, AlgoVaultSignal)
    assert out.action == "sell"
    assert out.verdict == "sell"
    assert out.confidence == pytest.approx(0.65)


def test_case_4_unknown_verdict_raises_with_signal_id() -> None:
    """Unknown verdict raises ValueError; message embeds the signal_id."""
    signal = base_buy_signal(action="long")
    with pytest.raises(ValueError) as excinfo:
        to_nautilus_signal(signal)
    msg = str(excinfo.value)
    assert "unknown verdict 'long'" in msg
    assert "test-buy-001" in msg


def test_case_5_missing_quantity_defaults_to_zero() -> None:
    """Missing `quantity` field defaults AlgoVaultSignal.quantity to 0.0."""
    signal = base_buy_signal()
    del signal["quantity"]
    out = to_nautilus_signal(signal)
    assert isinstance(out, AlgoVaultSignal)
    assert out.quantity == 0.0


def test_case_6_missing_merkle_proof_yields_none_anchor_url() -> None:
    """Missing `merkle_proof` field yields merkle_anchor_url == None."""
    signal = base_buy_signal(merkle_proof=None)
    out = to_nautilus_signal(signal)
    assert isinstance(out, AlgoVaultSignal)
    assert out.merkle_anchor_url is None


def test_case_7_structural_validation_all_fields_with_expected_types() -> None:
    """All 12 AlgoVaultSignal fields are present with expected types."""
    signal = base_buy_signal()
    out = to_nautilus_signal(signal)
    assert isinstance(out, AlgoVaultSignal)
    for field in REQUIRED_ALGOVAULT_SIGNAL_FIELDS:
        assert hasattr(out, field), f"missing field: {field}"
    # Type checks
    assert isinstance(out.signal_id, str)
    assert isinstance(out.market, str)
    assert isinstance(out.action, str)
    assert isinstance(out.symbol, str)
    assert isinstance(out.price, float)
    assert isinstance(out.quantity, float)
    assert isinstance(out.confidence, float)
    assert isinstance(out.verdict, str)
    assert out.merkle_anchor_url is None or isinstance(out.merkle_anchor_url, str)
    assert isinstance(out.venues_consulted, tuple)
    assert isinstance(out.ts_event, int)
    assert isinstance(out.ts_init, int)


def test_case_8_bonus_null_executed_at_falls_back_to_now() -> None:
    """When executed_at is None, ts_event defaults to current UTC nanoseconds."""
    signal = base_buy_signal(executed_at=None)
    before_ns = int(datetime.now(tz=timezone.utc).timestamp() * 1_000_000_000)
    out = to_nautilus_signal(signal)
    after_ns = int(datetime.now(tz=timezone.utc).timestamp() * 1_000_000_000)
    assert isinstance(out, AlgoVaultSignal)
    # ts_event should fall in [before_ns, after_ns] window (a few ms wide)
    assert before_ns <= out.ts_event <= after_ns


def test_case_9_bonus_anchor_url_surfaces_via_merkle_anchor_url() -> None:
    """Populated merkle_proof.anchor_url surfaces as AlgoVaultSignal.merkle_anchor_url."""
    signal = base_buy_signal(
        merkle_proof={
            "leaf": "0xabc",
            "root": "0xdef",
            "path": [],
            "anchor_url": "https://etherscan.io/tx/0xdeadbeef",
        },
    )
    out = to_nautilus_signal(signal)
    assert isinstance(out, AlgoVaultSignal)
    assert out.merkle_anchor_url == "https://etherscan.io/tx/0xdeadbeef"


# ---- Bonus: venues_consulted projection ----


def test_case_bonus_venues_consulted_tuple_from_cross_venue_metadata() -> None:
    """cross_venue_metadata.venues_consulted projects to AlgoVaultSignal.venues_consulted tuple."""
    signal = base_buy_signal(
        cross_venue_metadata={
            "venues_consulted": ["HL", "BINANCE", "BYBIT"],
            "venue_agreement_score": 1.0,
        },
    )
    out = to_nautilus_signal(signal)
    assert isinstance(out, AlgoVaultSignal)
    assert out.venues_consulted == ("HL", "BINANCE", "BYBIT")
    assert isinstance(out.venues_consulted, tuple)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
