/**
 * examples/ai4trade/tests/transform.test.ts
 *
 * Vitest unit tests for the pure transformer at examples/ai4trade/transform.ts.
 *
 * Coverage (7 cases per spec):
 *   1. HOLD signal → returns null
 *   2. BUY signal → output has all required ai4trade fields + verdict-formatted content
 *   3. SELL signal → action passes through
 *   4. Unknown verdict ("long") → throws with clear error
 *   5. Missing quantity → defaults to 0
 *   6. Missing merkle_proof → content contains "Merkle: pending"
 *   7. Structural validation → output has exactly the documented ai4trade required keys
 *
 * Zero network calls. Inline fixtures.
 */

import { describe, it, expect } from "vitest";
import {
  toAi4tradeRequest,
  type VerifiableSignalV1,
} from "../transform.js";

// ─── Helpers ───

function baseBuySignal(
  overrides: Partial<VerifiableSignalV1> = {},
): VerifiableSignalV1 {
  return {
    version: "1.0",
    signal_id: "test-buy-001",
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

const AI4TRADE_REQUIRED_KEYS = [
  "market",
  "action",
  "symbol",
  "price",
  "quantity",
  "executed_at",
] as const;

const AI4TRADE_ALLOWED_KEYS = new Set<string>([
  ...AI4TRADE_REQUIRED_KEYS,
  "content", // optional
]);

// ─── Tests ───

describe("toAi4tradeRequest", () => {
  it("case 1: HOLD signal returns null (skip publish)", () => {
    const signal = baseBuySignal({
      action: "hold",
      composite_verdict: { verdict: "hold", confidence: 0.52 },
    });
    expect(toAi4tradeRequest(signal)).toBeNull();
  });

  it("case 2: BUY signal produces full ai4trade body with verdict-formatted content", () => {
    const signal = baseBuySignal();
    const out = toAi4tradeRequest(signal);
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      market: "crypto",
      action: "buy",
      symbol: "BTC",
      price: 76742.4,
      quantity: 0.1,
      executed_at: "2026-05-22T16:11:21Z",
    });
    expect(out!.content).toContain("AlgoVault verdict: buy");
    expect(out!.content).toContain("confidence 78%");
  });

  it("case 3: SELL signal passes action through", () => {
    const signal = baseBuySignal({
      action: "sell",
      composite_verdict: { verdict: "sell", confidence: 0.65 },
    });
    const out = toAi4tradeRequest(signal);
    expect(out).not.toBeNull();
    expect(out!.action).toBe("sell");
    expect(out!.content).toContain("AlgoVault verdict: sell");
    expect(out!.content).toContain("confidence 65%");
  });

  it("case 4: unknown verdict throws with clear error", () => {
    // Cast through unknown to bypass the union type; the runtime guard catches it.
    const signal = baseBuySignal({
      action: "long" as unknown as VerifiableSignalV1["action"],
    });
    expect(() => toAi4tradeRequest(signal)).toThrow(/unknown verdict "long"/);
    expect(() => toAi4tradeRequest(signal)).toThrow(/signal_id=test-buy-001/);
  });

  it("case 5: missing quantity defaults to 0", () => {
    const signal = baseBuySignal({ quantity: undefined });
    const out = toAi4tradeRequest(signal);
    expect(out).not.toBeNull();
    expect(out!.quantity).toBe(0);
  });

  it("case 6: missing merkle_proof → content contains 'Merkle: pending'", () => {
    const signal = baseBuySignal({ merkle_proof: null });
    const out = toAi4tradeRequest(signal);
    expect(out).not.toBeNull();
    expect(out!.content).toContain("Merkle: pending");
  });

  it("case 7: output shape has all required ai4trade keys + no unexpected keys", () => {
    const signal = baseBuySignal();
    const out = toAi4tradeRequest(signal);
    expect(out).not.toBeNull();
    const outKeys = Object.keys(out!);
    // All required keys present
    for (const k of AI4TRADE_REQUIRED_KEYS) {
      expect(outKeys).toContain(k);
    }
    // No unexpected keys (only required + allowed-optional)
    for (const k of outKeys) {
      expect(AI4TRADE_ALLOWED_KEYS.has(k)).toBe(true);
    }
  });

  // ─── Bonus coverage (above the spec's 7-case minimum) ───

  it("bonus: null executed_at defaults to literal 'now'", () => {
    const signal = baseBuySignal({ executed_at: null });
    const out = toAi4tradeRequest(signal);
    expect(out).not.toBeNull();
    expect(out!.executed_at).toBe("now");
  });

  it("bonus: merkle_proof with anchor_url surfaces the URL in content", () => {
    const signal = baseBuySignal({
      merkle_proof: {
        leaf: "0xabc",
        root: "0xdef",
        path: [],
        anchor_url: "https://etherscan.io/tx/0xdeadbeef",
      },
    });
    const out = toAi4tradeRequest(signal);
    expect(out).not.toBeNull();
    expect(out!.content).toContain("Merkle: https://etherscan.io/tx/0xdeadbeef");
  });
});
