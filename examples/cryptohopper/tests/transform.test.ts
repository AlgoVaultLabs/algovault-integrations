/**
 * examples/cryptohopper/tests/transform.test.ts
 *
 * Vitest cases for the curried Cryptohopper transformer.
 *
 * Coverage (9 spec + 2 bonus = 11 cases):
 *   1. HOLD signal → returns null (skip publish; HOLD wastes points)
 *   2. BUY signal → type="buy" + all 5 required Cryptohopper keys
 *   3. SELL signal → type="sell"
 *   4. Unknown verdict ("long") → throws with signal_id in message
 *   5. Missing quantity → omitted from output (Cryptohopper Signaler endpoint
 *      has no `quantity`/`amount` field; trader-bots set position size)
 *   6. Missing merkle_proof → omitted from output (Cryptohopper has no
 *      first-class merkle field; the human-readable Merkle URL surfaces
 *      in agent-facing platforms like ai4trade.content, not in Cryptohopper)
 *   7. Structural validation: output has the 5 required Cryptohopper keys
 *      (api_key, signal_id, exchange, market, type) and NO unexpected keys
 *   8. `config.signal_id` (NOT `vs.signal_id`) populates output signal_id —
 *      Q-A correction: Cryptohopper's signal_id is the Signaler-account-static
 *      ID, NOT the per-emission UUID
 *   9. `config.exchange` (lowercase) populates output exchange — Cryptohopper
 *      convention is lowercase venue IDs (binance, kraken, etc.)
 *  10. Bonus: factory curry — same config + different signal → different
 *      output but identical api_key/signal_id/exchange (proves closure)
 *  11. Bonus: symbol_suffix config — "BTC" + suffix "BTC" → market "BTCBTC"
 *      (override default "USDT" for BTC-quote pairs)
 *
 * HMAC computation is NOT tested here (lives in run.ts; this file tests
 * the pure transformer only per the purity discipline shared across all
 * algovault-integrations examples).
 *
 * Zero network. Inline fixtures only. No fetch/MCP/http/node:crypto imports.
 */

import { describe, it, expect } from "vitest";
import {
  makeToCryptohopperRequest,
  type CryptohopperConfig,
  type VerifiableSignalV1,
} from "../transform.js";

// ─── Helpers ───

const TEST_CONFIG: CryptohopperConfig = {
  api_key: "test-api-key-001",
  hmac_secret: "test-hmac-secret-deadbeef",
  signal_id: "test-signaler-account-id-42",
  exchange: "binance",
};

function baseBuySignal(
  overrides: Partial<VerifiableSignalV1> = {},
): VerifiableSignalV1 {
  return {
    version: "1.0",
    signal_id: "test-ch-buy-001",
    emitted_at: "2026-05-22T16:11:21Z",
    market: "crypto",
    action: "buy",
    symbol: "BTC",
    price: 76742.4,
    quantity: 0.1,
    executed_at: "2026-05-22T16:11:21Z",
    composite_verdict: {
      verdict: "buy",
      confidence: 0.78,
    },
    merkle_proof: null,
    cross_venue_metadata: null,
    ...overrides,
  };
}

const REQUIRED_CRYPTOHOPPER_KEYS = [
  "api_key",
  "signal_id",
  "exchange",
  "market",
  "type",
] as const;

const ALLOWED_CRYPTOHOPPER_KEYS = new Set<string>(REQUIRED_CRYPTOHOPPER_KEYS);

// ─── Tests ───

describe("makeToCryptohopperRequest", () => {
  it("case 1: HOLD signal returns null (skip publish; HOLD wastes points)", () => {
    const toRequest = makeToCryptohopperRequest(TEST_CONFIG);
    const signal = baseBuySignal({
      action: "hold",
      composite_verdict: { verdict: "hold", confidence: 0.52 },
    });
    expect(toRequest(signal)).toBeNull();
  });

  it("case 2: BUY signal produces full body with type='buy'", () => {
    const toRequest = makeToCryptohopperRequest(TEST_CONFIG);
    const out = toRequest(baseBuySignal());
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      api_key: "test-api-key-001",
      signal_id: "test-signaler-account-id-42",
      exchange: "binance",
      market: "BTCUSDT",
      type: "buy",
    });
  });

  it("case 3: SELL signal produces full body with type='sell'", () => {
    const toRequest = makeToCryptohopperRequest(TEST_CONFIG);
    const out = toRequest(
      baseBuySignal({
        action: "sell",
        composite_verdict: { verdict: "sell", confidence: 0.65 },
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.type).toBe("sell");
  });

  it("case 4: unknown verdict throws with signal_id in message", () => {
    const toRequest = makeToCryptohopperRequest(TEST_CONFIG);
    const signal = baseBuySignal({
      action: "long" as unknown as VerifiableSignalV1["action"],
    });
    expect(() => toRequest(signal)).toThrow(/unknown verdict "long"/);
    expect(() => toRequest(signal)).toThrow(/signal_id=test-ch-buy-001/);
  });

  it("case 5: missing quantity is omitted (Cryptohopper Signaler has no quantity field)", () => {
    const toRequest = makeToCryptohopperRequest(TEST_CONFIG);
    const signal = baseBuySignal({ quantity: undefined });
    const out = toRequest(signal);
    expect(out).not.toBeNull();
    // Cryptohopper Signaler endpoint has no `quantity`/`amount` field;
    // subscriber trader-bots use their configured position sizing.
    expect(Object.keys(out!)).not.toContain("quantity");
    expect(Object.keys(out!)).not.toContain("amount");
    expect(Object.keys(out!)).not.toContain("order");
  });

  it("case 6: missing merkle_proof is omitted (no first-class Cryptohopper field)", () => {
    const toRequest = makeToCryptohopperRequest(TEST_CONFIG);
    const out = toRequest(baseBuySignal({ merkle_proof: null }));
    expect(out).not.toBeNull();
    // Cryptohopper Signaler endpoint has no merkle/anchor field; we MUST NOT
    // inject one (would be silently ignored + adds noise to the request audit).
    const keys = Object.keys(out!);
    expect(keys.some((k) => k.toLowerCase().includes("merkle"))).toBe(false);
    expect(keys.some((k) => k.toLowerCase().includes("anchor"))).toBe(false);
  });

  it("case 7: structural validation — exactly the 5 required keys, nothing extra", () => {
    const toRequest = makeToCryptohopperRequest(TEST_CONFIG);
    const out = toRequest(baseBuySignal());
    expect(out).not.toBeNull();
    const outKeys = Object.keys(out!).sort();
    // All required keys present
    for (const k of REQUIRED_CRYPTOHOPPER_KEYS) {
      expect(outKeys).toContain(k);
    }
    // No unexpected keys
    for (const k of outKeys) {
      expect(ALLOWED_CRYPTOHOPPER_KEYS.has(k)).toBe(true);
    }
    // Exactly 5 keys
    expect(outKeys.length).toBe(REQUIRED_CRYPTOHOPPER_KEYS.length);
  });

  it("case 8: config.signal_id (NOT vs.signal_id) populates output signal_id", () => {
    const toRequest = makeToCryptohopperRequest(TEST_CONFIG);
    // Per Q-A correction: Cryptohopper's signal_id is the Signaler-account
    // static ID from the user's API dashboard, NOT a per-emission UUID.
    // The vs.signal_id (per-emission) MUST NOT leak into the request body.
    const out = toRequest(
      baseBuySignal({ signal_id: "per-emission-uuid-DO-NOT-LEAK" }),
    );
    expect(out).not.toBeNull();
    expect(out!.signal_id).toBe("test-signaler-account-id-42");
    expect(out!.signal_id).not.toBe("per-emission-uuid-DO-NOT-LEAK");
  });

  it("case 9: config.exchange (lowercase) populates output exchange", () => {
    // Cryptohopper convention: lowercase exchange IDs (binance, kraken, etc.).
    const krakenRequest = makeToCryptohopperRequest({
      ...TEST_CONFIG,
      exchange: "kraken",
    });
    const out = krakenRequest(baseBuySignal());
    expect(out).not.toBeNull();
    expect(out!.exchange).toBe("kraken");
  });

  it("bonus 10: factory curry — closure holds config across multiple calls", () => {
    const toRequest = makeToCryptohopperRequest(TEST_CONFIG);
    const out1 = toRequest(baseBuySignal({ signal_id: "first", symbol: "BTC" }));
    const out2 = toRequest(
      baseBuySignal({
        signal_id: "second",
        symbol: "ETH",
        action: "sell",
        composite_verdict: { verdict: "sell", confidence: 0.7 },
      }),
    );
    expect(out1).not.toBeNull();
    expect(out2).not.toBeNull();
    // Different signals → different output content
    expect(out1!.market).toBe("BTCUSDT");
    expect(out2!.market).toBe("ETHUSDT");
    expect(out1!.type).toBe("buy");
    expect(out2!.type).toBe("sell");
    // Same config closure → identical api_key + signal_id + exchange
    expect(out1!.api_key).toBe(out2!.api_key);
    expect(out1!.signal_id).toBe(out2!.signal_id);
    expect(out1!.exchange).toBe(out2!.exchange);
  });

  it("bonus 11: symbol_suffix config controls market shape (USDT default, BTC override)", () => {
    const usdtRequest = makeToCryptohopperRequest(TEST_CONFIG); // default "USDT"
    const btcQuoteRequest = makeToCryptohopperRequest({
      ...TEST_CONFIG,
      symbol_suffix: "BTC",
    });
    const sig = baseBuySignal({ symbol: "ETH" });
    expect(usdtRequest(sig)!.market).toBe("ETHUSDT");
    expect(btcQuoteRequest(sig)!.market).toBe("ETHBTC");
  });
});
