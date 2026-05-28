"""
examples/hummingbot/run.py

End-to-end demo: fetch a verdict from AlgoVault MCP -> reshape into a
Verifiable-Signal v1.0 envelope -> transform to a HummingbotSignal TypedDict
-> log it as a Strategy.on_tick consumer would -> exit.

Default behavior: connects to the live AlgoVault MCP server, runs ONE end-to-end
round-trip, exits 0 on success. HOLD verdicts log a "skip publish" line and
exit 0 (per the locked-in HOLD-skip discipline; HOLDs are noise in a decision
loop and should never reach a Strategy's on_tick handler).

NOT a CI target — it makes a live MCP call to api.algovault.com. CI runs the
pure pytest cases only.

Run:
    python examples/hummingbot/run.py

Requires:
    pip install -e examples/hummingbot/.[dev]
    (Python 3.10.12+, network reach to api.algovault.com on 443)

Real Hummingbot StrategyV2Base integration:
    from decimal import Decimal
    from hummingbot.core.data_type.common import OrderType, TradeType
    from hummingbot.core.data_type.order_candidate import OrderCandidate

    class AlgoVaultStrategy(StrategyV2Base):
        def on_tick(self) -> None:
            sig = to_hummingbot_signal(self.fetch_envelope())
            if sig is None:
                return
            candidate = OrderCandidate(
                trading_pair=sig["trading_pair"],
                is_maker=False,
                order_type=OrderType[sig["order_type"]],
                order_side=TradeType[sig["order_side"]],
                amount=Decimal(str(sig["amount"])),
                price=Decimal(str(sig["price"] or 0)),
            )
            # ... submit via BudgetChecker + connector.place_order()
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from transform import (
    HummingbotSignal,
    VerifiableSignalV1,
    to_hummingbot_signal,
)

ALGOVAULT_MCP_URL = "https://api.algovault.com/mcp"
PROBE_COIN = "BTC"
PROBE_TIMEFRAME = "5m"
PROBE_EXCHANGE = "BINANCE"

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%SZ",
)
log = logging.getLogger("run")


def _exit_with_message(msg: str, code: int) -> None:
    sys.stderr.write(f"{msg}\n")
    sys.exit(code)


def reshape_to_envelope(
    raw: dict,
    coin: str,
    timeframe: str,
) -> VerifiableSignalV1:
    """Reshape the raw `get_trade_call` MCP response into a Verifiable-Signal v1.0 envelope.

    Mirrors the derivation rules documented in G1's worked-example fixture
    (tests/fixtures/verifiable-signal-v1-sample.README.md):
    - confidence: 0-100 int -> 0.0-1.0 float
    - timestamp: unix epoch seconds -> ISO 8601 UTC
    - signal_id: freshly-generated UUID v4 (runtime does not yet emit a stable ID)
    """
    call = str(raw.get("call", "")).lower()
    confidence_raw = float(raw.get("confidence", 0.0) or 0.0)
    confidence = confidence_raw / 100.0 if confidence_raw > 1.0 else confidence_raw
    price_raw = raw.get("price")
    price = float(price_raw) if isinstance(price_raw, (int, float)) else None
    reasoning_raw = raw.get("reasoning")
    reasoning = str(reasoning_raw) if isinstance(reasoning_raw, str) else None
    unix_ts = raw.get("timestamp")
    if isinstance(unix_ts, (int, float)):
        emitted_at = (
            datetime.fromtimestamp(float(unix_ts), tz=timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )
    else:
        emitted_at = (
            datetime.now(tz=timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )

    envelope: VerifiableSignalV1 = {
        "version": "1.0",
        "signal_id": str(uuid.uuid4()),
        "emitted_at": emitted_at,
        "market": "crypto",
        "action": call,
        "symbol": coin,
        "price": price,
        "quantity": None,
        "timeframe": timeframe,
        "executed_at": None,
        "content": reasoning,
        "composite_verdict": {"verdict": call, "confidence": confidence},
        "merkle_proof": None,
        "cross_venue_metadata": None,
    }
    return envelope


async def _fetch_get_trade_call(
    coin: str,
    timeframe: str,
    exchange: str,
) -> dict[str, Any]:
    """Open an MCP streamable-HTTP session and call `get_trade_call` once."""
    log.info("connecting to %s", ALGOVAULT_MCP_URL)
    async with streamablehttp_client(ALGOVAULT_MCP_URL) as (read, write, _get_session_id):
        async with ClientSession(read, write) as session:
            await session.initialize()
            log.info(
                "calling get_trade_call(coin=%s, timeframe=%s, exchange=%s)",
                coin,
                timeframe,
                exchange,
            )
            result = await session.call_tool(
                "get_trade_call",
                {
                    "coin": coin,
                    "timeframe": timeframe,
                    "includeReasoning": True,
                    "exchange": exchange,
                },
            )
    content = result.content
    if not content:
        raise RuntimeError("MCP get_trade_call returned empty content")
    first = content[0]
    text = getattr(first, "text", None)
    if not isinstance(text, str):
        raise RuntimeError(
            f"unexpected MCP response shape; expected text content, got {type(first).__name__}"
        )
    return json.loads(text)


def _log_hummingbot_signal(signal: HummingbotSignal) -> None:
    """Demonstrate the in-process Hummingbot consume path.

    Avoids the full StrategyV2Base + Connector + BudgetChecker bootstrap
    (which would require an exchange connector config, paper-trade keys, and
    a running event loop owned by Hummingbot's framework). Instead, this
    function plays the role of a Strategy's on_tick handler: it receives the
    HummingbotSignal dict and logs every field a real Strategy would feed into
    `OrderCandidate(...)` before submitting via the connector.

    In a production Hummingbot Strategy, the equivalent shape is documented
    at the top of this file's module docstring.

    See https://hummingbot.org/ and the Hummingbot V2 strategy guide for the
    full Connector + BudgetChecker + place_order wiring.
    """
    log.info("HummingbotSignal ready for Strategy.on_tick consumption: %s", signal["signal_id"])
    log.info("  trading_pair       = %s", signal["trading_pair"])
    log.info("  order_side         = %s", signal["order_side"])
    log.info("  order_type         = %s", signal["order_type"])
    log.info("  amount             = %s", signal["amount"])
    log.info("  price              = %s", signal["price"])
    log.info("  signal_id          = %s", signal["signal_id"])
    log.info("  verdict            = %s", signal["verdict"])
    log.info("  confidence         = %.3f", signal["confidence"])
    log.info("  merkle_anchor_url  = %s", signal["merkle_anchor_url"] or "<pending>")
    log.info("  venues_consulted   = %s", signal["venues_consulted"] or "()")
    log.info("  ts_event_ns        = %d", signal["ts_event_ns"])


async def _main_async() -> int:
    try:
        raw = await _fetch_get_trade_call(PROBE_COIN, PROBE_TIMEFRAME, PROBE_EXCHANGE)
    except Exception as exc:
        _exit_with_message(f"ERROR: MCP fetch failed: {exc}", 2)
        return 2  # unreachable; satisfies type checker

    envelope = reshape_to_envelope(raw, PROBE_COIN, PROBE_TIMEFRAME)
    log.info(
        "envelope: verdict=%s confidence=%.3f signal_id=%s",
        envelope["action"],
        envelope["composite_verdict"]["confidence"],
        envelope["signal_id"],
    )

    signal = to_hummingbot_signal(envelope)
    if signal is None:
        log.info("verdict HOLD; skipping Hummingbot publish per transform contract")
        return 0

    _log_hummingbot_signal(signal)
    log.info("demo complete; clean exit")
    return 0


def main() -> None:
    try:
        rc = asyncio.run(_main_async())
    except KeyboardInterrupt:
        _exit_with_message("ERROR: interrupted", 130)
        return
    except Exception as exc:
        _exit_with_message(f"ERROR: {exc}", 99)
        return
    sys.exit(rc)


if __name__ == "__main__":
    main()
