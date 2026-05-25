/**
 * examples/cryptohopper/transform.ts
 *
 * Pure transformer: AlgoVault Verifiable-Signal v1.0 envelope → Cryptohopper
 * external-Signaler GET request body.
 *
 * Curry pattern: Cryptohopper requires per-Signaler config (api_key + hmac_secret
 * + exchange + signal_id) that is NOT carried in the signal. The factory
 * `makeToCryptohopperRequest(config)` returns a function with the locked-in
 * shape `(signal: VerifiableSignalV1) => CryptohopperRequest | null`,
 * preserving the contract established by G2-W1 (toAi4tradeRequest), G2-W2
 * (to_nautilus_signal), G2-W3 (makeToThreeCommasRequest).
 *
 * No I/O, no fetch, no env reads, NO `node:crypto` import (HMAC computation
 * is deferred to run.ts per the transform.ts purity discipline; the
 * transformer produces the request body, run.ts signs it).
 *
 * Mapping rules (architect-ratified 2026-05-25; Q-A revisions applied):
 *   - composite_verdict.verdict === "buy"  → type: "buy"
 *   - composite_verdict.verdict === "sell" → type: "sell"
 *   - composite_verdict.verdict === "hold" → return null (skip publish;
 *     HOLD wastes points + clutters the Signaler feed)
 *   - unknown verdict                       → throws Error with signal_id
 *   - symbol + config.symbol_suffix         → market (e.g. "BTC" + "USDT" → "BTCUSDT")
 *   - config.api_key                        → api_key
 *   - config.signal_id                      → signal_id (Q-A correction:
 *     Cryptohopper's `signal_id` is the Signaler-account-static-ID from the
 *     user's API dashboard, NOT a per-emission UUID. Per-emission tracking
 *     uses the natural key (api_key, signal_id, market, type, timestamp)
 *     on Cryptohopper's side; we just pass the static account ID.)
 *   - config.exchange                       → exchange (lowercase per
 *     Cryptohopper convention; default "binance")
 *
 * The HMAC-sha512 signature over the path-with-query is computed by run.ts
 * (which has access to `node:crypto`) and sent as the `X-Hub-Signature`
 * header (raw hex, no `sha512=` prefix per WebSearch-corroborated PHP
 * verification snippet using `hash_equals(header, hash_hmac(...))`).
 *
 * References:
 *   - Cryptohopper Signaler Guide:
 *     https://docs.cryptohopper.com/docs/marketplace-sellers/signaler-guide/
 *   - AlgoVault Verifiable-Signal Interop Spec v1.0:
 *     https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md
 *   - JSON Schema $id (canonical SoT):
 *     https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/schemas/verifiable-signal-v1.json
 *
 * Imports the shared VerifiableSignalV1 type from OPS-SHARED-TS-PRIMITIVES-
 * EXTRACTION-W1 (validates compounding economy: this is the first TS-platform
 * example AFTER the shared/ extraction).
 */

import type { VerifiableSignalV1 } from "../../shared/types/verifiable-signal-v1.js";
export type { VerifiableSignalV1 };

// ─── Cryptohopper external-Signaler GET request ───

export interface CryptohopperConfig {
  /** Per-Signaler API key from the Cryptohopper user's API section. */
  api_key: string;
  /** HMAC secret for sha512 signature computation. Used by run.ts only. */
  hmac_secret: string;
  /**
   * Cryptohopper's Signaler-account-static-ID (NOT a per-emission UUID).
   * Found in the user's Cryptohopper API dashboard. Per-emission tracking
   * uses (api_key, signal_id, market, type, timestamp) on Cryptohopper's
   * side; this ID stays constant per Signaler account.
   */
  signal_id: string;
  /**
   * Cryptohopper exchange ID (lowercase per their convention).
   * Documented enum per W1 audit: bitpanda, bitvavo, hitbtc, kucoin, okex,
   * binance, binanceus, bitfinex, bittrex, cex, gdax, huobi, kraken2,
   * kraken, poloniex.
   */
  exchange: string;
  /**
   * Suffix appended to vs.symbol to build the market parameter.
   * Default: "USDT" (most common Cryptohopper Signaler base pair).
   * Override for BTC-quote pairs etc.
   */
  symbol_suffix?: string;
}

export interface CryptohopperRequest {
  api_key: string;
  signal_id: string;
  exchange: string;
  market: string;
  type: "buy" | "sell";
}

// ─── Internal helpers ───

function verdictToType(verdict: string, signalId: string): "buy" | "sell" {
  if (verdict === "buy") return "buy";
  if (verdict === "sell") return "sell";
  throw new Error(
    `makeToCryptohopperRequest: unsupported verdict "${verdict}" in signal.action; ` +
      `expected one of: hold, buy, sell (signal_id=${signalId})`,
  );
}

// ─── Factory ───

const PUBLISHABLE_VERDICTS = new Set<VerifiableSignalV1["action"]>([
  "buy",
  "sell",
]);

/**
 * Build a per-Signaler transformer closure. The returned function carries
 * the locked-in factory shape (signal) => XRequest | null shared across all
 * algovault-integrations examples.
 *
 * Throws synchronously at call-time on unknown verdicts (returns null on
 * HOLD per the skip-publish contract).
 */
export function makeToCryptohopperRequest(
  config: CryptohopperConfig,
): (signal: VerifiableSignalV1) => CryptohopperRequest | null {
  const symbolSuffix = config.symbol_suffix ?? "USDT";

  return function toCryptohopperRequest(
    signal: VerifiableSignalV1,
  ): CryptohopperRequest | null {
    const verdict = signal.action;

    if (verdict === "hold") {
      return null;
    }

    if (!PUBLISHABLE_VERDICTS.has(verdict)) {
      throw new Error(
        `makeToCryptohopperRequest: unknown verdict "${verdict}" in signal.action; ` +
          `expected one of: hold, buy, sell (signal_id=${signal.signal_id})`,
      );
    }

    return {
      api_key: config.api_key,
      signal_id: config.signal_id,
      exchange: config.exchange,
      market: `${signal.symbol}${symbolSuffix}`,
      type: verdictToType(verdict, signal.signal_id),
    };
  };
}
