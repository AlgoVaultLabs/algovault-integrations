/**
 * examples/3commas/transform.ts
 *
 * Pure transformer: AlgoVault Verifiable-Signal v1.0 envelope → 3Commas
 * Signal Bot custom-signal webhook body.
 *
 * Curry pattern: 3Commas requires per-bot config (secret + bot_uuid + max_lag
 * + symbol_suffix + tv_exchange) that is NOT carried in the signal. The
 * factory `makeToThreeCommasRequest(config)` returns a function with the
 * locked-in shape `(signal: VerifiableSignalV1) => ThreeCommasRequest | null`,
 * preserving the contract established by G2-W1 (toAi4tradeRequest) and
 * G2-W2 (to_nautilus_signal).
 *
 * No I/O, no fetch, no env reads. Input in, output out, deterministic.
 *
 * Mapping rules (architect-ratified 2026-05-23, with Q-A correction from
 * Plan-Mode P3 + P6 re-verify against live 3Commas + TradingView docs):
 *   - composite_verdict.verdict === "buy"  → action: "enter_long"
 *   - composite_verdict.verdict === "sell" → action: "enter_short"
 *   - composite_verdict.verdict === "hold" → return null (skip publish;
 *     HOLD wastes quota + clutters the bot's signal feed)
 *   - unknown verdict                       → throws Error with signal_id
 *   - symbol + config.symbol_suffix        → tv_instrument
 *     (e.g. "BTC" + "USDT.P" → "BTCUSDT.P")
 *   - vs.price                              → trigger_price (number → String)
 *   - vs.executed_at (ISO 8601)             → timestamp (ISO 8601 passthrough;
 *     per live 3Commas docs "accepted in ISO8601 format" and TV
 *     {{timenow}} placeholder which renders as ISO yyyy-MM-ddTHH:mm:ssZ).
 *     When vs.executed_at is null/missing, falls back to current UTC ISO.
 *   - config.secret + config.bot_uuid       → secret + bot_uuid passthrough
 *   - config.max_lag (default "300")        → max_lag (string seconds)
 *   - config.tv_exchange (default "BINANCE") → tv_exchange
 *
 * References:
 *   - 3Commas Signal Bot custom-signal JSON docs:
 *     https://help.3commas.io/en/articles/8894481-signal-bot-json-file-in-custom-signal-type
 *   - AlgoVault Verifiable-Signal Interop Spec v1.0:
 *     https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md
 *   - JSON Schema $id (canonical SoT):
 *     https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/schemas/verifiable-signal-v1.json
 *
 * Per Plan-Mode Q-D acknowledgement: this is the 3rd example using a
 * hand-written VerifiableSignalV1 interface (ai4trade + nautilus + this).
 * Threshold for extraction to shared/types/ is met but deferred to a
 * dedicated follow-up wave (OPS-SHARED-TS-TYPES-EXTRACTION-W1 candidate).
 */

// ─── Verifiable-Signal v1.0 (hand-written; mirrors ai4trade/transform.ts) ───

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
  [key: string]: unknown;
}

// ─── 3Commas Signal Bot custom-signal payload ───

export interface ThreeCommasConfig {
  /** Per-bot secret token from the Signal Bot configuration UI. */
  secret: string;
  /** Signal Bot UUID from the bot config. */
  bot_uuid: string;
  /** Max signal-lag in seconds (string). Default: "300". */
  max_lag?: string;
  /** TradingView-style exchange identifier. Default: "BINANCE". */
  tv_exchange?: string;
  /**
   * Suffix appended to vs.symbol to build tv_instrument.
   * Default: "USDT.P" (Binance USDT-margined perpetual futures, matching
   * AlgoVault MCP get_trade_call's default exchange=BINANCE which is perp).
   * Override to "USDT" for spot bots, or other pair suffixes per venue.
   */
  symbol_suffix?: string;
}

export interface ThreeCommasRequest {
  secret: string;
  max_lag: string;
  timestamp: string;
  trigger_price: string;
  tv_exchange: string;
  tv_instrument: string;
  action: "enter_long" | "enter_short";
  bot_uuid: string;
}

// ─── Internal helpers ───

function verdictToAction(verdict: string): "enter_long" | "enter_short" {
  if (verdict === "buy") return "enter_long";
  if (verdict === "sell") return "enter_short";
  // Unreachable for valid v1.0 envelopes; outer factory filters HOLD + unknown.
  throw new Error(`verdictToAction: unsupported verdict "${verdict}"`);
}

function executedAtOrNow(iso: string | null | undefined): string {
  if (iso == null || iso === "") {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return iso;
}

// ─── Factory ───

const PUBLISHABLE_VERDICTS = new Set<VerifiableSignalV1["action"]>([
  "buy",
  "sell",
]);

/**
 * Build a per-bot transformer closure. The returned function carries the
 * locked-in factory shape (signal) => XRequest | null shared across all
 * algovault-integrations examples.
 *
 * Throws synchronously at call-time on unknown verdicts (returns null on
 * HOLD per the skip-publish contract).
 */
export function makeToThreeCommasRequest(
  config: ThreeCommasConfig,
): (signal: VerifiableSignalV1) => ThreeCommasRequest | null {
  const maxLag = config.max_lag ?? "300";
  const tvExchange = config.tv_exchange ?? "BINANCE";
  const symbolSuffix = config.symbol_suffix ?? "USDT.P";

  return function toThreeCommasRequest(
    signal: VerifiableSignalV1,
  ): ThreeCommasRequest | null {
    const verdict = signal.action;

    if (verdict === "hold") {
      return null;
    }

    if (!PUBLISHABLE_VERDICTS.has(verdict)) {
      throw new Error(
        `makeToThreeCommasRequest: unknown verdict "${verdict}" in signal.action; ` +
          `expected one of: hold, buy, sell (signal_id=${signal.signal_id})`,
      );
    }

    return {
      secret: config.secret,
      max_lag: maxLag,
      timestamp: executedAtOrNow(signal.executed_at),
      trigger_price: String(signal.price ?? 0),
      tv_exchange: tvExchange,
      tv_instrument: `${signal.symbol}${symbolSuffix}`,
      action: verdictToAction(verdict),
      bot_uuid: config.bot_uuid,
    };
  };
}
