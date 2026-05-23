/**
 * shared/types/verifiable-signal-v1.ts
 *
 * Canonical TypeScript SoT for the AlgoVault Verifiable-Signal v1.0 envelope.
 *
 * Auto-mirrored from the G1 JSON Schema; update both in lockstep on a v1.1
 * (additive) or v2.0 (breaking) version bump.
 *
 * References:
 *   - Verifiable-Signal Interop Spec v1.0:
 *     https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md
 *   - Canonical JSON Schema $id:
 *     https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/schemas/verifiable-signal-v1.json
 *
 * Forward-compat: schema is `additionalProperties: true`. The `[key: string]:
 * unknown` index signature on `VerifiableSignalV1` lets consumers carry
 * forward-version fields through without type errors.
 *
 * NOT npm-published. Internal to the algovault-integrations mono-repo.
 * Per-platform examples import via:
 *
 *     import { VerifiableSignalV1 } from "../../shared/types/verifiable-signal-v1.js";
 */

// ─── Verifiable-Signal v1.0 ───

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
