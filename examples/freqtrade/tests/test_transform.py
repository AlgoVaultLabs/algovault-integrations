"""
examples/freqtrade/tests/test_transform.py

Pytest cases at parity with G2-W2 nautilus + extended for FreqTrade 4-flag
semantics. Coverage: 10 spec + 2 FreqTrade-specific = 12 cases.

Cases:
    1.  HOLD signal -> to_freqtrade_signal returns None
    2.  BUY signal  -> enter_long=True; pair="BTC/USDT"; enter_tag starts with "algovault-buy-"
    3.  SELL signal -> enter_short=True only
    4.  Unknown verdict ("long") -> raises ValueError with signal_id in message
    5.  Missing quantity -> still returns valid FreqtradeSignal (no signal-side quantity)
    6.  Missing merkle_proof -> merkle_anchor_url is None
    7.  Structural validation -> all 13 fields present with expected types
    8.  (bonus) Null executed_at -> ts_event_ns defaults to current UTC nanoseconds
    9.  (bonus) Populated merkle_proof.anchor_url -> merkle_anchor_url equals it
    10. (bonus) cross_venue_metadata.venues_consulted projects to tuple
    11. (FreqTrade-specific) pair format: BTC->BTC/USDT, ETH->ETH/USDT, SOL->SOL/USDT
    12. (FreqTrade-specific) short/cover flag exclusivity: exactly ONE flag True per verdict

Zero network. Zero MCP imports. Zero freqtrade imports. Inline dict fixtures only.

This test file does NOT import `freqtrade`. The transformer is pure and the
FreqtradeSignal TypedDict mirrors the canonical 4-flag IStrategy shape without
depending on the freqtrade.strategy.IStrategy class hierarchy.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from transform import (
    FreqtradeSignal,
    VerifiableSignalV1,
    to_freqtrade_signal,
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


REQUIRED_FREQTRADE_SIGNAL_FIELDS = (
    "pair",
    "enter_long",
    "enter_short",
    "exit_long",
    "exit_short",
    "enter_tag",
    "exit_tag",
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
    assert to_freqtrade_signal(signal) is None


def test_case_2_buy_signal_produces_enter_long() -> None:
    """BUY verdict produces FreqtradeSignal with enter_long=True only."""
    signal = base_buy_signal()
    out = to_freqtrade_signal(signal)
    assert out is not None
    assert out["enter_long"] is True
    assert out["enter_short"] is False
    assert out["exit_long"] is False
    assert out["exit_short"] is False
    assert out["pair"] == "BTC/USDT"
    assert out["enter_tag"] is not None
    assert out["enter_tag"].startswith("algovault-buy-")
    assert out["exit_tag"] is None
    assert out["signal_id"] == "test-buy-001"
    assert out["confidence"] == pytest.approx(0.78)
    assert out["verdict"] == "buy"
    # ts_event_ns should be derived from executed_at (2026-05-22T16:11:21Z)
    expected_ns = int(
        datetime(2026, 5, 22, 16, 11, 21, tzinfo=timezone.utc).timestamp()
        * 1_000_000_000
    )
    assert out["ts_event_ns"] == expected_ns


def test_case_3_sell_signal_produces_enter_short() -> None:
    """SELL verdict produces FreqtradeSignal with enter_short=True only."""
    signal = base_buy_signal(
        action="sell",
        composite_verdict={"verdict": "sell", "confidence": 0.65},
    )
    out = to_freqtrade_signal(signal)
    assert out is not None
    assert out["enter_long"] is False
    assert out["enter_short"] is True
    assert out["exit_long"] is False
    assert out["exit_short"] is False
    assert out["enter_tag"] is not None
    assert out["enter_tag"].startswith("algovault-sell-")
    assert out["exit_tag"] is None
    assert out["verdict"] == "sell"
    assert out["confidence"] == pytest.approx(0.65)


def test_case_4_unknown_verdict_raises_with_signal_id() -> None:
    """Unknown verdict raises ValueError; message embeds the signal_id."""
    signal = base_buy_signal(action="long")
    with pytest.raises(ValueError) as excinfo:
        to_freqtrade_signal(signal)
    msg = str(excinfo.value)
    assert "unknown verdict 'long'" in msg
    assert "test-buy-001" in msg


def test_case_5_missing_quantity_does_not_affect_output() -> None:
    """Missing `quantity` still returns valid FreqtradeSignal.

    FreqTrade decides position size at the strategy layer via stake_amount /
    custom_stake_amount, not via signal-side quantity, so quantity is
    intentionally absent from FreqtradeSignal.
    """
    signal = base_buy_signal()
    del signal["quantity"]
    out = to_freqtrade_signal(signal)
    assert out is not None
    # All required fields present and the BUY mapping is unchanged
    for field in REQUIRED_FREQTRADE_SIGNAL_FIELDS:
        assert field in out, f"missing field: {field}"
    assert out["enter_long"] is True
    assert out["pair"] == "BTC/USDT"


def test_case_6_missing_merkle_proof_yields_none_anchor_url() -> None:
    """Missing `merkle_proof` field yields merkle_anchor_url == None."""
    signal = base_buy_signal(merkle_proof=None)
    out = to_freqtrade_signal(signal)
    assert out is not None
    assert out["merkle_anchor_url"] is None


def test_case_7_structural_validation_all_fields_with_expected_types() -> None:
    """All 13 FreqtradeSignal fields are present with expected types."""
    signal = base_buy_signal()
    out = to_freqtrade_signal(signal)
    assert out is not None
    for field in REQUIRED_FREQTRADE_SIGNAL_FIELDS:
        assert field in out, f"missing field: {field}"
    # Type checks
    assert isinstance(out["pair"], str)
    assert isinstance(out["enter_long"], bool)
    assert isinstance(out["enter_short"], bool)
    assert isinstance(out["exit_long"], bool)
    assert isinstance(out["exit_short"], bool)
    assert out["enter_tag"] is None or isinstance(out["enter_tag"], str)
    assert out["exit_tag"] is None or isinstance(out["exit_tag"], str)
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
    out = to_freqtrade_signal(signal)
    after_ns = int(datetime.now(tz=timezone.utc).timestamp() * 1_000_000_000)
    assert out is not None
    # ts_event_ns should fall in [before_ns, after_ns] window (a few ms wide)
    assert before_ns <= out["ts_event_ns"] <= after_ns


def test_case_9_bonus_anchor_url_surfaces() -> None:
    """Populated merkle_proof.anchor_url surfaces as FreqtradeSignal.merkle_anchor_url."""
    signal = base_buy_signal(
        merkle_proof={
            "leaf": "0xabc",
            "root": "0xdef",
            "path": [],
            "anchor_url": "https://etherscan.io/tx/0xdeadbeef",
        },
    )
    out = to_freqtrade_signal(signal)
    assert out is not None
    assert out["merkle_anchor_url"] == "https://etherscan.io/tx/0xdeadbeef"


def test_case_10_bonus_venues_consulted_tuple() -> None:
    """cross_venue_metadata.venues_consulted projects to FreqtradeSignal.venues_consulted tuple."""
    signal = base_buy_signal(
        cross_venue_metadata={
            "venues_consulted": ["HL", "BINANCE", "BYBIT"],
            "venue_agreement_score": 1.0,
        },
    )
    out = to_freqtrade_signal(signal)
    assert out is not None
    assert out["venues_consulted"] == ("HL", "BINANCE", "BYBIT")
    assert isinstance(out["venues_consulted"], tuple)


# ---- FreqTrade-specific tests ----


def test_case_11_freqtrade_specific_pair_format() -> None:
    """pair follows FreqTrade slash convention: BTC->BTC/USDT, ETH->ETH/USDT, SOL->SOL/USDT."""
    for coin, expected_pair in (
        ("BTC", "BTC/USDT"),
        ("ETH", "ETH/USDT"),
        ("SOL", "SOL/USDT"),
    ):
        signal = base_buy_signal(
            symbol=coin,
            signal_id=f"test-pair-{coin.lower()}",
        )
        out = to_freqtrade_signal(signal)
        assert out is not None, f"unexpected None for {coin}"
        assert out["pair"] == expected_pair, (
            f"pair mismatch for symbol={coin}: got {out['pair']!r}, expected {expected_pair!r}"
        )


def test_case_12_freqtrade_specific_short_cover_flag_exclusivity() -> None:
    """SHORT and COVER verdicts each flip exactly ONE flag True; rest False."""
    # SHORT -> enter_short only
    short_signal = base_buy_signal(
        action="short",
        composite_verdict={"verdict": "short", "confidence": 0.71},
    )
    out_short = to_freqtrade_signal(short_signal)
    assert out_short is not None
    assert out_short["enter_long"] is False
    assert out_short["enter_short"] is True
    assert out_short["exit_long"] is False
    assert out_short["exit_short"] is False
    assert out_short["enter_tag"] is not None
    assert out_short["enter_tag"].startswith("algovault-short-")
    assert out_short["exit_tag"] is None
    # Exactly one of the four flags is True
    flags_short = (
        out_short["enter_long"],
        out_short["enter_short"],
        out_short["exit_long"],
        out_short["exit_short"],
    )
    assert sum(1 for f in flags_short if f is True) == 1

    # COVER -> exit_short only
    cover_signal = base_buy_signal(
        action="cover",
        composite_verdict={"verdict": "cover", "confidence": 0.69},
    )
    out_cover = to_freqtrade_signal(cover_signal)
    assert out_cover is not None
    assert out_cover["enter_long"] is False
    assert out_cover["enter_short"] is False
    assert out_cover["exit_long"] is False
    assert out_cover["exit_short"] is True
    assert out_cover["enter_tag"] is None
    assert out_cover["exit_tag"] is not None
    assert out_cover["exit_tag"].startswith("algovault-cover-")
    # Exactly one of the four flags is True
    flags_cover = (
        out_cover["enter_long"],
        out_cover["enter_short"],
        out_cover["exit_long"],
        out_cover["exit_short"],
    )
    assert sum(1 for f in flags_cover if f is True) == 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
