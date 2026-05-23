/**
 * examples/ai4trade/transform.ts
 *
 * Pure transformer: AlgoVault Verifiable-Signal v1.0 envelope → ai4trade
 * `POST /api/signals/realtime` request body.
 *
 * No I/O, no fetch, no env reads. Input in, output out, deterministic.
 *
 * Mapping rules (architect-ratified 2026-05-22):
 *   - market         → 1:1 string passthrough
 *   - action         → pass `buy`/`sell` through; return null on `hold`
 *                       (skip publish; HOLD wastes points + clutters the feed);
 *                       throw on any other verdict
 *   - symbol         → 1:1 string passthrough
 *   - price          → 1:1 number passthrough (defaults to 0 when absent;
 *                       ai4trade treats 0 as "auto-query current price")
 *   - quantity       → 1:1 number passthrough; defaults to 0.0 when absent
 *                       (documents "informational signal, no position size implied")
 *   - composite_verdict → formatted into ai4trade.content as
 *                       `AlgoVault verdict: {verdict} | confidence {pct}% | Merkle: {url|pending}`
 *   - executed_at    → ISO 8601 passthrough; defaults to literal "now"
 *                       when null/missing (delegates to ai4trade's auto-time
 *                       per their Method 2 platform-simulated-trade convention)
 *
 * The `VerifiableSignalV1` interface is hoisted to `shared/types/verifiable-signal-v1.ts`
 * (single SoT across all TS examples — see OPS-SHARED-TS-PRIMITIVES-EXTRACTION-W1).
 * Re-exported here so `run.ts` + tests can continue importing it from `../transform.js`
 * (preserves the existing import path; no churn in downstream files).
 */

import type { VerifiableSignalV1 } from "../../shared/types/verifiable-signal-v1.js";
export type { VerifiableSignalV1 };

// ─── ai4trade `POST /api/signals/realtime` request body ───

export interface Ai4tradeRequest {
  market: string;
  action: "buy" | "sell" | "short" | "cover";
  symbol: string;
  price: number;
  quantity: number;
  content?: string;
  executed_at: string;
}

// ─── Transformer ───

const PUBLISHABLE_VERDICTS = new Set<VerifiableSignalV1["action"]>([
  "buy",
  "sell",
  "short",
  "cover",
]);

/**
 * Map a Verifiable-Signal v1.0 envelope to an ai4trade signals/realtime
 * request body, OR return null when the verdict is `hold` (skip publish).
 *
 * Throws on unknown verdict values (e.g. "long", "exit") with a clear
 * error message identifying the offending field + value.
 */
export function toAi4tradeRequest(
  signal: VerifiableSignalV1,
): Ai4tradeRequest | null {
  const verdict = signal.action;

  if (verdict === "hold") {
    return null;
  }

  if (!PUBLISHABLE_VERDICTS.has(verdict)) {
    throw new Error(
      `toAi4tradeRequest: unknown verdict "${verdict}" in signal.action; ` +
        `expected one of: hold, buy, sell, short, cover (signal_id=${signal.signal_id})`,
    );
  }

  const confidencePct = Math.round(signal.composite_verdict.confidence * 100);
  const anchorUrl = signal.merkle_proof?.anchor_url ?? "pending";
  const content =
    `AlgoVault verdict: ${signal.composite_verdict.verdict} ` +
    `| confidence ${confidencePct}% ` +
    `| Merkle: ${anchorUrl}`;

  const executedAt =
    signal.executed_at == null || signal.executed_at === ""
      ? "now"
      : signal.executed_at;

  return {
    market: signal.market,
    action: verdict,
    symbol: signal.symbol,
    price: signal.price ?? 0,
    quantity: signal.quantity ?? 0,
    content,
    executed_at: executedAt,
  };
}
