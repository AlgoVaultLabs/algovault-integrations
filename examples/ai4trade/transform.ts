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
 * The hand-written VerifiableSignalV1 interface mirrors the schema's properties
 * block at https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/schemas/verifiable-signal-v1.json
 * Future examples may share a `types/verifiable-signal-v1.ts` when ≥3 examples
 * import it; until then, in-folder duplication keeps this example self-contained.
 */

// ─── Verifiable-Signal v1.0 (subset — required + fields this transform reads) ───

export interface VerifiableSignalV1 {
  version: string;
  signal_id: string;
  emitted_at: string;
  market: string;
  action: "buy" | "sell" | "short" | "cover" | "hold";
  symbol: string;
  price?: number | null;
  quantity?: number | null;
  timeframe?: string;
  executed_at?: string | null;
  content?: string | null;
  composite_verdict: {
    verdict: "buy" | "sell" | "short" | "cover" | "hold";
    confidence: number;
    factor_weights?: Record<string, number>;
  };
  merkle_proof?: {
    leaf: string;
    root: string;
    path: Array<{ sibling: string; position: "left" | "right" }>;
    hash_algo?: "sha256" | "keccak256" | "blake3";
    published_at?: string | null;
    anchor_url?: string | null;
  } | null;
  cross_venue_metadata?: {
    venues_consulted: string[];
    venue_agreement_score?: number | null;
    per_venue_verdicts?: Record<string, "buy" | "sell" | "short" | "cover" | "hold">;
  } | null;
  // Forward-compat: schema is additionalProperties: true. Unknown keys preserved
  // by the caller (not by this transform — this transform reads documented fields only).
  [key: string]: unknown;
}

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
