"""
examples/hummingbot/tests/test_transform.py

Pytest cases at parity with G2-W2's nautilus test shape.
Coverage: 10 spec + 2 Hummingbot-specific = 12 cases.

Zero network. Zero MCP imports. Zero hummingbot imports. Inline dict fixtures only.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from transform import (
    HummingbotSignal,
    VerifiableSignalV1,
    to_hummingbot_signal,
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


REQUIRED_HUMMINGBOT_SIGNAL_FIELDS = (
    "trading_pair",
    "order_side",
    "order_type",
    "amount",
    "price",
    "signal_id",
    "confidence",
    "verdict",
    "merkle_anchor_url",
    "venues_consulted",
    "ts_event_ns",
)


# ---- Tests ----


def test_case_1_hold_signal_returns_none() -> None:
    """HOLD verdict skips publish (returns None)."""
    signal = base_buy_signal(
        action="hold",
        composite_verdict={"verdict": "hold", "confidence": 0.52},
    )
    assert to_hummingbot_signal(signal) is None


def test_case_2_buy_signal_produces_full_signal() -> None:
    """BUY verdict produces a HummingbotSignal dict with all required fields."""
    signal = base_buy_signal()
    out = to_hummingbot_signal(signal)
    assert out is not None
    assert isinstance(out, dict)
    assert out["order_side"] == "BUY"
    assert out["order_type"] == "MARKET"
    assert out["trading_pair"] == "BTC-USDT"
    assert out["amount"] == pytest.approx(0.1)
    assert out["price"] == pytest.approx(76742.4)
    assert out["confidence"] == pytest.approx(0.78)
    assert out["verdict"] == "buy"
    assert out["signal_id"] == "test-buy-001"
    # ts_event_ns should be derived from executed_at (2026-05-22T16:11:21Z)
    expected_ns = int(
        datetime(2026, 5, 22, 16, 11, 21, tzinfo=timezone.utc).timestamp()
        * 1_000_000_000
    )
    assert out["ts_event_ns"] == expected_ns


def test_case_3_sell_signal_passes_action_through() -> None:
    """SELL verdict produces a HummingbotSignal with order_side='SELL'."""
    signal = base_buy_signal(
        action="sell",
        composite_verdict={"verdict": "sell", "confidence": 0.65},
    )
    out = to_hummingbot_signal(signal)
    assert out is not None
    assert out["order_side"] == "SELL"
    assert out["verdict"] == "sell"
    assert out["confidence"] == pytest.approx(0.65)


def test_case_4_unknown_verdict_raises_with_signal_id() -> None:
    """Unknown verdict raises ValueError; message embeds the signal_id."""
    signal = base_buy_signal(action="long")
    with pytest.raises(ValueError) as excinfo:
        to_hummingbot_signal(signal)
    msg = str(excinfo.value)
    assert "unknown verdict 'long'" in msg
    assert "test-buy-001" in msg


def test_case_5_missing_quantity_defaults_to_zero() -> None:
    """Missing `quantity` field defaults HummingbotSignal.amount to 0.0."""
    signal = base_buy_signal()
    del signal["quantity"]
    out = to_hummingbot_signal(signal)
    assert out is not None
    assert out["amount"] == 0.0


def test_case_6_missing_merkle_proof_yields_none_anchor_url() -> None:
    """Missing `merkle_proof` field yields merkle_anchor_url == None."""
    signal = base_buy_signal(merkle_proof=None)
    out = to_hummingbot_signal(signal)
    assert out is not None
    assert out["merkle_anchor_url"] is None


def test_case_7_structural_validation_all_fields_with_expected_types() -> None:
    """All 11 HummingbotSignal fields are present with expected types."""
    signal = base_buy_signal()
    out = to_hummingbot_signal(signal)
    assert out is not None
    for field in REQUIRED_HUMMINGBOT_SIGNAL_FIELDS:
        assert field in out, f"missing field: {field}"
    # Type checks
    assert isinstance(out["trading_pair"], str)
    assert isinstance(out["order_side"], str)
    assert isinstance(out["order_type"], str)
    assert isinstance(out["amount"], float)
    assert out["price"] is None or isinstance(out["price"], float)
    assert isinstance(out["signal_id"], str)
    assert isinstance(out["confidence"], float)
    assert isinstance(out["verdict"], str)
    assert out["merkle_anchor_url"] is None or isinstance(out["merkle_anchor_url"], str)
    assert isinstance(out["venues_consulted"], tuple)
    assert isinstance(out["ts_event_ns"], int)


def test_case_8_bonus_null_executed_at_falls_back_to_now() -> None:
    """When executed_at is None, ts_event_ns defaults to current UTC nanoseconds."""
    signal = base_buy_signal(executed_at=None)
    before_ns = int(datetime.now(tz=timezone.utc).timestamp() * 1_000_000_000)
    out = to_hummingbot_signal(signal)
    after_ns = int(datetime.now(tz=timezone.utc).timestamp() * 1_000_000_000)
    assert out is not None
    # ts_event_ns should fall in [before_ns, after_ns] window (a few ms wide)
    assert before_ns <= out["ts_event_ns"] <= after_ns


def test_case_9_bonus_anchor_url_surfaces_via_merkle_anchor_url() -> None:
    """Populated merkle_proof.anchor_url surfaces as HummingbotSignal.merkle_anchor_url."""
    signal = base_buy_signal(
        merkle_proof={
            "leaf": "0xabc",
            "root": "0xdef",
            "path": [],
            "anchor_url": "https://etherscan.io/tx/0xdeadbeef",
        },
    )
    out = to_hummingbot_signal(signal)
    assert out is not None
    assert out["merkle_anchor_url"] == "https://etherscan.io/tx/0xdeadbeef"


def test_case_10_bonus_venues_consulted_tuple_from_cross_venue_metadata() -> None:
    """cross_venue_metadata.venues_consulted projects to HummingbotSignal.venues_consulted tuple."""
    signal = base_buy_signal(
        cross_venue_metadata={
            "venues_consulted": ["HL", "BINANCE", "BYBIT"],
            "venue_agreement_score": 1.0,
        },
    )
    out = to_hummingbot_signal(signal)
    assert out is not None
    assert out["venues_consulted"] == ("HL", "BINANCE", "BYBIT")
    assert isinstance(out["venues_consulted"], tuple)


# ---- Hummingbot-specific cases ----


def test_case_11_hummingbot_specific_trading_pair_format() -> None:
    """trading_pair follows Hummingbot's '<base>-<quote>' convention with USDT as the hardcoded quote."""
    for symbol in ("BTC", "ETH", "SOL"):
        signal = base_buy_signal(symbol=symbol)
        out = to_hummingbot_signal(signal)
        assert out is not None
        assert out["trading_pair"] == f"{symbol}-USDT"


def test_case_12_hummingbot_specific_cover_short_verdict_mapping() -> None:
    """short -> SELL (open short = sell); cover -> BUY (close short = buy back)."""
    short_signal = base_buy_signal(
        action="short",
        composite_verdict={"verdict": "short", "confidence": 0.71},
    )
    short_out = to_hummingbot_signal(short_signal)
    assert short_out is not None
    assert short_out["order_side"] == "SELL"
    assert short_out["verdict"] == "short"

    cover_signal = base_buy_signal(
        action="cover",
        composite_verdict={"verdict": "cover", "confidence": 0.69},
    )
    cover_out = to_hummingbot_signal(cover_signal)
    assert cover_out is not None
    assert cover_out["order_side"] == "BUY"
    assert cover_out["verdict"] == "cover"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
