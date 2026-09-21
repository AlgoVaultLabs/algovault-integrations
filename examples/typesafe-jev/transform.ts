/**
 * examples/typesafe-jev/transform.ts
 *
 * Decision-layer transformer: AlgoVault Verifiable-Signal v1.0 envelope →
 * TypeSafe System One request for Jev, plus the pure decide() step that turns
 * Jev's answers into act / hold / escalate.
 *
 * Where this sits. The other transform examples in this repo hand a verdict
 * DOWNSTREAM to an execution platform. This one sits BETWEEN the verdict and
 * execution: AlgoVault says what the market is doing, Jev judges whether to act
 * on it now, and code applies every threshold. Nothing here places an order.
 *
 * Pure module: no network, no environment reads, no filesystem, no crypto, no
 * logging. run.ts owns all I/O. The SDK import below is type-only and is
 * erased at compile time, so this file loads without the SDK installed.
 *
 * Design constraints, each a documented Jev failure mode
 * (https://docs.typesafe.ai/model-jaggedness/jev-1.13):
 *   - No floats reach Jev. Confidence and venue agreement are bucketed here:
 *     "do the conversion in code and pass in either the computed number or a
 *     named bucket".
 *   - Minimal state. Only the fields a question reads. The Merkle proof, the
 *     price and the reasoning text never enter state: "Accuracy falls as the
 *     state grows with content unrelated to the decision".
 *   - Nothing code can compute exactly is asked of Jev. Position conflict is a
 *     lookup over (verdict, position), so conflictsWithPosition() computes it
 *     and state carries the result for act_now to weigh.
 *   - One question, one judgment. Every question spells out its boundary cases
 *     in `criteria`, and no Noul maps `true` to a negative reading.
 *
 * Questions and thresholds live in this one file, per TypeSafe's review
 * guidance (https://docs.typesafe.ai/agent-skill).
 *
 * Trust boundary: `state` is built from AlgoVault MCP output, which this
 * example treats as trusted. Jev does not treat state as hostile by default;
 * a fork that feeds it untrusted input owns that boundary.
 *
 * References:
 *   - TypeSafe System One API: https://docs.typesafe.ai/api
 *   - AlgoVault Verifiable-Signal Interop Spec v1.0:
 *     https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md
 */

import type {
  JsonValue,
  NoulQuestion,
  Questions,
  ScoreQuestion,
  SystemOneRequest,
} from "@typesafe-ai/sdk";
import type { VerifiableSignalV1 } from "../../shared/types/verifiable-signal-v1.js";
export type { VerifiableSignalV1 };

// ─── Pinned model ───

/**
 * The only place the Jev model id appears in code. Pinned, never an alias:
 * TypeSafe's aliases move when a new release ships, so "the answers behind it
 * can change without a change on your side" (https://docs.typesafe.ai/models).
 * decide() acts only on answers whose `model` is exactly this id.
 */
export const JEV_MODEL = "jev-1.13.0";

// ─── Thresholds ───

/**
 * Every numeric gate, in one frozen object. These are illustrative defaults:
 * tune them against JEV_MODEL on your own data, and re-tune when you move the
 * pin.
 */
export const THRESHOLDS = Object.freeze({
  /** Inclusive lower bounds for naming a 0–1 value (confidence, venue agreement). */
  band: Object.freeze({ high: 0.7, medium: 0.5 }),
  /** act_now Noul: act at or above `act`, hold at or below `wait`, escalate in between. */
  actNow: Object.freeze({ act: 0.7, wait: 0.3 }),
  /** regime_fit Score on its 0–2 scale: hold when the expected score is below `min`. */
  regimeFit: Object.freeze({ min: 1.0 }),
});

// ─── Types ───

export type Band = "high" | "medium" | "low";
export type Position = "long" | "short" | "flat";
export type Verdict = VerifiableSignalV1["composite_verdict"]["verdict"];
export type Decision = "act" | "hold" | "escalate";

export interface JevTradeContext {
  /** The caller's open position. AlgoVault never sees it; only this request does. */
  position: Position;
  /** Symbol the position is on. A position on another symbol is sent as "flat". */
  positionSymbol?: string;
}

/** The part of the SDK's `SystemOneResult` that decide() reads. */
export interface JevResult {
  readonly model: string;
  readonly answers: Readonly<Record<string, unknown>>;
}

export interface JevDecision {
  decision: Decision;
  reasons: string[];
}

// ─── Questions ───

const ACT_NOW: NoulQuestion = Object.freeze({
  type: "noul",
  instructions:
    "Whether to act on this verdict on this scan rather than wait for the next one.",
  criteria: Object.freeze({
    true:
      "Act on this scan: the state gives a clear, well-supported reason to take the " +
      "verdict's side now, for example a high confidence_band, a regime moving the " +
      "verdict's way, and venues that agree when venue fields are present.",
    false:
      "Wait for the next scan: the reason to act is weak or mixed, for example a low " +
      "confidence_band, a medium confidence_band with no regime support, a regime " +
      "moving against the verdict, venues that disagree, or conflicts_with_position " +
      "is true.",
  }),
});

const REGIME_FIT_LEVELS = [
  "Poor fit: the regime works against an entry in the verdict's direction (for " +
    "example TRENDING_DOWN under a buy or cover verdict, TRENDING_UP under a sell " +
    "or short verdict), or offers no direction to follow (for example RANGING).",
  "Mixed fit: the regime neither supports nor opposes an entry in the verdict's " +
    "direction (for example VOLATILE).",
  "Good fit: the regime points the same way as the verdict (for example " +
    "TRENDING_UP under a buy or cover verdict, TRENDING_DOWN under a sell or short " +
    "verdict).",
] as const;

const REGIME_FIT: ScoreQuestion<typeof REGIME_FIT_LEVELS> = Object.freeze({
  type: "score",
  instructions: "How well the reported regime suits a directional entry.",
  criteria: Object.freeze(REGIME_FIT_LEVELS),
});

// ─── Helpers ───

type ActionableVerdict = Exclude<Verdict, "hold">;

const ACTIONABLE = new Set<string>(["buy", "sell", "short", "cover"]);
const BULLISH = new Set<Verdict>(["buy", "cover"]);
const BEARISH = new Set<Verdict>(["sell", "short"]);

function isActionable(v: unknown): v is ActionableVerdict {
  return typeof v === "string" && ACTIONABLE.has(v);
}

function isUnitInterval(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function regimeOf(signal: VerifiableSignalV1): string | null {
  const regime = signal.regime;
  return typeof regime === "string" && regime.trim() !== "" ? regime.trim() : null;
}

function positionOnSymbol(symbol: string, ctx: JevTradeContext): Position {
  if (
    ctx.positionSymbol !== undefined &&
    ctx.positionSymbol.toUpperCase() !== symbol.toUpperCase()
  ) {
    return "flat";
  }
  return ctx.position;
}

/** The cross-venue fields, only when the emitter populated them; agreement is bucketed. */
function venueFields(signal: VerifiableSignalV1): Record<string, JsonValue> {
  const meta = signal.cross_venue_metadata;
  if (meta === null || meta === undefined) return {};

  const out: Record<string, JsonValue> = {};
  if (Array.isArray(meta.venues_consulted) && meta.venues_consulted.length > 0) {
    out.venues_consulted = [...meta.venues_consulted];
  }
  const score = meta.venue_agreement_score;
  if (score !== null && score !== undefined) {
    if (!isUnitInterval(score)) {
      throw new RangeError(
        `toJevRequest: cross_venue_metadata.venue_agreement_score must be a finite number ` +
          `in [0, 1], got ${String(score)} (signal_id=${signal.signal_id})`,
      );
    }
    out.venue_agreement_band = bucketConfidence(score);
  }
  const perVenue = meta.per_venue_verdicts;
  if (perVenue && Object.keys(perVenue).length > 0) {
    out.per_venue_verdicts = { ...perVenue };
  }
  return out;
}

function noulOf(answer: unknown): number | null {
  if (!isRecord(answer) || answer.type !== "noul") return null;
  return isUnitInterval(answer.noul) ? answer.noul : null;
}

function scoreOf(answer: unknown): number | null {
  if (!isRecord(answer) || answer.type !== "score") return null;
  const score = answer.score;
  const top = REGIME_FIT_LEVELS.length - 1;
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= top
    ? score
    : null;
}

function escalate(reasons: string[], why: string): JevDecision {
  return { decision: "escalate", reasons: [...reasons, why] };
}

// ─── Public API ───

/** Name a 0–1 value by THRESHOLDS.band. Refuses anything outside a finite [0, 1]. */
export function bucketConfidence(c: number): Band {
  if (!isUnitInterval(c)) {
    throw new RangeError(`bucketConfidence: expected a finite number in [0, 1], got ${String(c)}`);
  }
  if (c >= THRESHOLDS.band.high) return "high";
  if (c >= THRESHOLDS.band.medium) return "medium";
  return "low";
}

/**
 * Whether a verdict points against the open position: a bearish verdict (sell,
 * short) against a long, or a bullish one (buy, cover) against a short. Flat
 * never conflicts, and neither does hold.
 */
export function conflictsWithPosition(verdict: Verdict, position: Position): boolean {
  if (position === "long") return BEARISH.has(verdict);
  if (position === "short") return BULLISH.has(verdict);
  return false;
}

/**
 * Build the System One request for one verdict.
 *
 * Returns null on HOLD: the market says wait, and a Jev call on a no-trade is
 * waste. Throws, with the signal_id, on an unknown verdict or a confidence
 * outside [0, 1]. Asks `regime_fit` only when the envelope carries a regime.
 */
export function toJevRequest(
  signal: VerifiableSignalV1,
  ctx: JevTradeContext,
): SystemOneRequest | null {
  const verdict: unknown = signal.composite_verdict?.verdict;
  if (verdict === "hold") return null;
  if (!isActionable(verdict)) {
    throw new Error(
      `toJevRequest: unknown verdict "${String(verdict)}" in composite_verdict.verdict; ` +
        `expected one of: buy, sell, short, cover, hold (signal_id=${signal.signal_id})`,
    );
  }

  const confidence = signal.composite_verdict.confidence;
  if (!isUnitInterval(confidence)) {
    throw new RangeError(
      `toJevRequest: composite_verdict.confidence must be a finite number in [0, 1], ` +
        `got ${String(confidence)} (signal_id=${signal.signal_id})`,
    );
  }

  const position = positionOnSymbol(signal.symbol, ctx);
  const regime = regimeOf(signal);

  const state: Record<string, JsonValue> = {
    symbol: signal.symbol,
    market: signal.market,
    ...(typeof signal.timeframe === "string" ? { timeframe: signal.timeframe } : {}),
    verdict,
    confidence_band: bucketConfidence(confidence),
    ...(regime !== null ? { regime } : {}),
    ...venueFields(signal),
    position,
    conflicts_with_position: conflictsWithPosition(verdict, position),
  };

  const questions: Questions = { act_now: ACT_NOW };
  if (regime !== null) questions.regime_fit = REGIME_FIT;

  return { model: JEV_MODEL, state, questions };
}

/**
 * Turn Jev's answers into act / hold / escalate. Pure, and it never throws: a
 * guard on a live decision path refuses rather than crashing the caller.
 *
 *   1. Answered by any model other than JEV_MODEL → escalate. The Vercel AI
 *      Gateway reports only the unversioned `typesafe-ai/jev`, so that leg
 *      always lands here.
 *   2. conflicts_with_position (computed in code) → escalate.
 *   3. regime_fit asked and below THRESHOLDS.regimeFit.min → hold.
 *   4. act_now at or above THRESHOLDS.actNow.act → act; at or below
 *      THRESHOLDS.actNow.wait → hold; in between → escalate.
 *
 * A missing or malformed state or answer escalates.
 */
export function decide(request: SystemOneRequest, result: JevResult): JevDecision {
  const reasons: string[] = [];

  if (result.model !== JEV_MODEL) {
    return escalate(
      reasons,
      `answered by model "${result.model}", not the pinned ${JEV_MODEL}: THRESHOLDS do not apply`,
    );
  }

  const state = request.state;
  if (!isRecord(state) || typeof state.conflicts_with_position !== "boolean") {
    return escalate(reasons, "request state is missing conflicts_with_position");
  }
  if (state.conflicts_with_position) {
    return escalate(reasons, "the verdict conflicts with the open position");
  }

  const answers: Record<string, unknown> = isRecord(result.answers) ? result.answers : {};

  if (isRecord(request.questions) && "regime_fit" in request.questions) {
    const fit = scoreOf(answers.regime_fit);
    if (fit === null) {
      return escalate(reasons, "regime_fit was asked but its answer is missing or malformed");
    }
    if (fit < THRESHOLDS.regimeFit.min) {
      return {
        decision: "hold",
        reasons: [...reasons, `regime_fit ${fit} is below ${THRESHOLDS.regimeFit.min}`],
      };
    }
    reasons.push(`regime_fit ${fit} meets ${THRESHOLDS.regimeFit.min}`);
  }

  const actNow = noulOf(answers.act_now);
  if (actNow === null) {
    return escalate(reasons, "act_now answer is missing or malformed");
  }
  if (actNow >= THRESHOLDS.actNow.act) {
    return {
      decision: "act",
      reasons: [...reasons, `act_now ${actNow} is at or above ${THRESHOLDS.actNow.act}`],
    };
  }
  if (actNow <= THRESHOLDS.actNow.wait) {
    return {
      decision: "hold",
      reasons: [...reasons, `act_now ${actNow} is at or below ${THRESHOLDS.actNow.wait}`],
    };
  }
  return escalate(
    reasons,
    `act_now ${actNow} is between ${THRESHOLDS.actNow.wait} and ${THRESHOLDS.actNow.act}`,
  );
}
