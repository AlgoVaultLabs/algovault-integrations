/**
 * shared/lib/reshape-to-envelope.ts
 *
 * Canonical TypeScript SoT for reshaping a raw `get_trade_call` MCP response
 * into a Verifiable-Signal v1.0 envelope.
 *
 * Pure function: no I/O, no env reads, no `fetch()`. Uses `node:crypto.randomUUID`
 * for the synthetic `signal_id` (the MCP server does not yet emit a stable
 * signal-id; WIS-flagged for future when it does).
 *
 * Mirrors the derivation rules documented in G1's worked-example fixture
 * (crypto-quant-signal-mcp/tests/fixtures/verifiable-signal-v1-sample.README.md):
 *   - confidence: 0-100 int -> 0.0-1.0 float
 *   - timestamp: unix epoch seconds -> ISO 8601 UTC (`.toISOString()`,
 *     stripped of milliseconds for tidy ISO `yyyy-MM-ddTHH:mm:ssZ`)
 *   - signal_id: freshly-generated UUIDv4
 *   - merkle_proof / cross_venue_metadata: default to null
 *
 * Per-platform examples import via:
 *
 *     import { reshapeToEnvelope } from "../../shared/lib/reshape-to-envelope.js";
 */

import { randomUUID } from "node:crypto";
import type { VerifiableSignalV1 } from "../types/verifiable-signal-v1.js";

/**
 * Reshape a raw MCP `get_trade_call` response into a Verifiable-Signal v1.0
 * envelope. The `coin` + `timeframe` args carry the input context that the
 * raw response does not echo back (envelope's `symbol` + `timeframe` fields).
 */
export function reshapeToEnvelope(
  raw: Record<string, unknown>,
  coin: string,
  timeframe: string,
): VerifiableSignalV1 {
  const call = String(raw.call ?? "").toLowerCase() as VerifiableSignalV1["action"];
  const confidenceRaw = Number(raw.confidence ?? 0);
  const confidence = confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw;
  const price = typeof raw.price === "number" ? raw.price : null;
  const reasoning = typeof raw.reasoning === "string" ? raw.reasoning : null;
  const unixTs = typeof raw.timestamp === "number" ? raw.timestamp : null;
  const emittedAt =
    unixTs != null
      ? new Date(unixTs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
      : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  return {
    version: "1.0",
    signal_id: randomUUID(),
    emitted_at: emittedAt,
    market: "crypto",
    action: call,
    symbol: coin,
    price,
    quantity: null,
    timeframe,
    executed_at: null,
    content: reasoning,
    composite_verdict: {
      verdict: call,
      confidence,
    },
    merkle_proof: null,
    cross_venue_metadata: null,
  };
}
