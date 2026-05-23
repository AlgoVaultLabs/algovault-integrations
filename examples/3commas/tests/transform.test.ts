/**
 * examples/3commas/tests/transform.test.ts
 *
 * Vitest cases for the curried 3Commas transformer.
 *
 * Coverage (7 spec + 2 bonus = 9 cases):
 *   1. HOLD signal → returns null
 *   2. BUY signal → action="enter_long" + all required 3Commas keys
 *   3. SELL signal → action="enter_short"
 *   4. Unknown verdict ("long") → throws with signal_id in message
 *   5. Missing quantity → omitted from output (3Commas Signal Bot uses
 *      its configured base order size; we don't pass `order.amount` to
 *      avoid coupling with bot config)
 *   6. Missing merkle_proof → omitted from output (3Commas has no
 *      first-class merkle field; the human-readable Merkle URL surfaces
 *      in agent-facing platforms like ai4trade.content, not in 3Commas)
 *   7. Structural validation: output has the 8 required 3Commas keys
 *      (secret, bot_uuid, action, trigger_price, timestamp, tv_exchange,
 *      tv_instrument, max_lag) and NO unexpected keys
 *   8. Bonus: factory curry — same config + different signal → different
 *      output but identical secret/bot_uuid (proves closure holds config)
 *   9. Bonus: symbol_suffix config — "BTC" + suffix "USDT.P" →
 *      tv_instrument: "BTCUSDT.P"
 *
 * Zero network. Inline fixtures only. No fetch/MCP/http imports.
 */

import { describe, it, expect } from "vitest";
import {
  makeToThreeCommasRequest,
  type ThreeCommasConfig,
  type VerifiableSignalV1,
} from "../transform.js";

// ─── Helpers ───

const TEST_CONFIG: ThreeCommasConfig = {
  secret: "test-secret-token",
  bot_uuid: "test-bot-uuid-001",
};

function baseBuySignal(
  overrides: Partial<VerifiableSignalV1> = {},
): VerifiableSignalV1 {
  return {
    version: "1.0",
    signal_id: "test-3c-buy-001",
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

const REQUIRED_THREE_COMMAS_KEYS = [
  "secret",
  "max_lag",
  "timestamp",
  "trigger_price",
  "tv_exchange",
  "tv_instrument",
  "action",
  "bot_uuid",
] as const;

const ALLOWED_THREE_COMMAS_KEYS = new Set<string>(REQUIRED_THREE_COMMAS_KEYS);

// ─── Tests ───

describe("makeToThreeCommasRequest", () => {
  it("case 1: HOLD signal returns null (skip publish)", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
    const signal = baseBuySignal({
      action: "hold",
      composite_verdict: { verdict: "hold", confidence: 0.52 },
    });
    expect(toRequest(signal)).toBeNull();
  });

  it("case 2: BUY signal produces full body with action='enter_long'", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
    const out = toRequest(baseBuySignal());
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      secret: "test-secret-token",
      bot_uuid: "test-bot-uuid-001",
      action: "enter_long",
      trigger_price: "76742.4",
      timestamp: "2026-05-22T16:11:21Z",
      tv_exchange: "BINANCE",
      tv_instrument: "BTCUSDT.P",
      max_lag: "300",
    });
  });

  it("case 3: SELL signal produces full body with action='enter_short'", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
    const out = toRequest(
      baseBuySignal({
        action: "sell",
        composite_verdict: { verdict: "sell", confidence: 0.65 },
      }),
    );
    expect(out).not.toBeNull();
    expect(out!.action).toBe("enter_short");
  });

  it("case 4: unknown verdict throws with signal_id in message", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
    const signal = baseBuySignal({
      action: "long" as unknown as VerifiableSignalV1["action"],
    });
    expect(() => toRequest(signal)).toThrow(/unknown verdict "long"/);
    expect(() => toRequest(signal)).toThrow(/signal_id=test-3c-buy-001/);
  });

  it("case 5: missing quantity is omitted from output (3Commas uses bot config size)", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
    const signal = baseBuySignal({ quantity: undefined });
    const out = toRequest(signal);
    expect(out).not.toBeNull();
    // Output shape MUST NOT carry `quantity` or any `order.*` keys at all —
    // 3Commas Signal Bot uses its configured base order size.
    expect(Object.keys(out!)).not.toContain("quantity");
    expect(Object.keys(out!)).not.toContain("order");
  });

  it("case 6: missing merkle_proof is omitted (no first-class 3Commas field)", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
    const out = toRequest(baseBuySignal({ merkle_proof: null }));
    expect(out).not.toBeNull();
    // 3Commas Signal Bot custom-signal schema has no merkle/anchor field;
    // we MUST NOT inject one (would be silently ignored + adds noise to the
    // request audit log on 3Commas's side).
    const keys = Object.keys(out!);
    expect(keys.some((k) => k.toLowerCase().includes("merkle"))).toBe(false);
    expect(keys.some((k) => k.toLowerCase().includes("anchor"))).toBe(false);
  });

  it("case 7: structural validation — exactly the 8 required keys, nothing extra", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
    const out = toRequest(baseBuySignal());
    expect(out).not.toBeNull();
    const outKeys = Object.keys(out!).sort();
    // All required keys present
    for (const k of REQUIRED_THREE_COMMAS_KEYS) {
      expect(outKeys).toContain(k);
    }
    // No unexpected keys
    for (const k of outKeys) {
      expect(ALLOWED_THREE_COMMAS_KEYS.has(k)).toBe(true);
    }
    // Exactly 8 keys
    expect(outKeys.length).toBe(REQUIRED_THREE_COMMAS_KEYS.length);
  });

  it("bonus 8: factory curry — closure holds config across multiple calls", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
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
    expect(out1!.tv_instrument).toBe("BTCUSDT.P");
    expect(out2!.tv_instrument).toBe("ETHUSDT.P");
    expect(out1!.action).toBe("enter_long");
    expect(out2!.action).toBe("enter_short");
    // Same config closure → identical secret + bot_uuid
    expect(out1!.secret).toBe(out2!.secret);
    expect(out1!.bot_uuid).toBe(out2!.bot_uuid);
  });

  it("bonus 9: symbol_suffix config controls tv_instrument shape", () => {
    const spotRequest = makeToThreeCommasRequest({
      ...TEST_CONFIG,
      symbol_suffix: "USDT",
    });
    const perpRequest = makeToThreeCommasRequest({
      ...TEST_CONFIG,
      symbol_suffix: "USDT.P",
    });
    const customSuffixRequest = makeToThreeCommasRequest({
      ...TEST_CONFIG,
      symbol_suffix: "PERP",
    });
    const sig = baseBuySignal({ symbol: "BTC" });
    expect(spotRequest(sig)!.tv_instrument).toBe("BTCUSDT");
    expect(perpRequest(sig)!.tv_instrument).toBe("BTCUSDT.P");
    expect(customSuffixRequest(sig)!.tv_instrument).toBe("BTCPERP");
  });

  // ─── Bonus extra: Q-A regression test (ISO 8601 passthrough, not unix-ms conversion) ───

  it("bonus extra: timestamp is ISO 8601 passthrough (not unix-ms conversion)", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
    const signal = baseBuySignal({ executed_at: "2026-05-22T16:11:21Z" });
    const out = toRequest(signal);
    expect(out).not.toBeNull();
    // Per live 3Commas docs (verified 2026-05-23): timestamp accepted in
    // ISO 8601 format. Must NOT be converted to unix-ms string.
    expect(out!.timestamp).toBe("2026-05-22T16:11:21Z");
    expect(out!.timestamp).not.toMatch(/^\d{13}$/); // not a 13-digit unix-ms
  });

  it("bonus extra: null executed_at falls back to current UTC ISO", () => {
    const toRequest = makeToThreeCommasRequest(TEST_CONFIG);
    const out = toRequest(baseBuySignal({ executed_at: null }));
    expect(out).not.toBeNull();
    // Must look like ISO 8601 (yyyy-MM-ddTHH:mm:ssZ)
    expect(out!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
