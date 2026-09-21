/**
 * examples/typesafe-jev/tests/transform.test.ts
 *
 * Vitest cases for the decision-layer transformer and its pure decide() step.
 *
 * Spec cases (INTEGRATIONS-TYPESAFE-JEV-W1 R2):
 *   1. HOLD verdict → null (no Jev call)
 *   2. Unknown verdict → throws, message carries the signal_id
 *   3. BUY and SELL → exactly two question ids (one when `regime` is absent);
 *      `position_conflict` is never a question
 *   4. No raw float reaches `state`
 *   5. `merkle_proof` never reaches `state`
 *   6. DRIFT GATE — JEV_MODEL is a pinned, versioned model id
 *   7. Every confidence bucket is reachable, boundaries included
 *
 * Also covered: venue fields only when `cross_venue_metadata` is non-null,
 * the code-computed position conflict, the `state` allow-list, and decide(),
 * including AC7b (a response from any model other than JEV_MODEL is capped at
 * "escalate" and never throws).
 *
 * Zero network. Inline fixtures only. Every import comes through ../transform.js.
 */

import { describe, it, expect } from "vitest";
import {
  JEV_MODEL,
  THRESHOLDS,
  bucketConfidence,
  conflictsWithPosition,
  decide,
  toJevRequest,
  type JevResult,
  type JevTradeContext,
  type VerifiableSignalV1,
} from "../transform.js";

// ─── Fixtures ───

type Verdict = VerifiableSignalV1["composite_verdict"]["verdict"];

/** A BUY envelope shaped like reshapeToEnvelope's output plus the forward-compat `regime` key. */
function signal(overrides: Partial<VerifiableSignalV1> = {}): VerifiableSignalV1 {
  return {
    version: "1.0",
    signal_id: "test-jev-buy-001",
    emitted_at: "2026-09-21T09:15:27Z",
    market: "crypto",
    action: "buy",
    symbol: "BTC",
    price: 83960.6,
    quantity: null,
    timeframe: "5m",
    executed_at: null,
    content: "Composite BUY on 5m.",
    composite_verdict: { verdict: "buy", confidence: 0.7342 },
    merkle_proof: null,
    cross_venue_metadata: null,
    regime: "TRENDING_UP",
    ...overrides,
  };
}

function withVerdict(
  verdict: Verdict,
  overrides: Partial<VerifiableSignalV1> = {},
): VerifiableSignalV1 {
  return signal({
    action: verdict,
    composite_verdict: { verdict, confidence: 0.7342 },
    signal_id: `test-jev-${verdict}-001`,
    ...overrides,
  });
}

const FLAT: JevTradeContext = { position: "flat" };

const CROSS_VENUE: NonNullable<VerifiableSignalV1["cross_venue_metadata"]> = {
  venues_consulted: ["HL", "BINANCE", "BYBIT"],
  venue_agreement_score: 0.6667,
  per_venue_verdicts: { HL: "buy", BINANCE: "buy", BYBIT: "hold" },
};

const MERKLE: NonNullable<VerifiableSignalV1["merkle_proof"]> = {
  leaf: "0xleaf5e1ec7ab1ec0ffee",
  root: "0xro07deadbeefcafe",
  path: [{ sibling: "0xs1b1ingf00d", position: "left" }],
  hash_algo: "sha256",
};

function requestFor(s: VerifiableSignalV1, ctx: JevTradeContext = FLAT) {
  const req = toJevRequest(s, ctx);
  if (req === null) throw new Error("fixture expected a request, got null");
  return req;
}

function stateOf(s: VerifiableSignalV1, ctx: JevTradeContext = FLAT): Record<string, unknown> {
  const state = requestFor(s, ctx).state;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("fixture expected an object state");
  }
  return state as Record<string, unknown>;
}

function questionIds(s: VerifiableSignalV1, ctx: JevTradeContext = FLAT): string[] {
  return Object.keys(requestFor(s, ctx).questions).sort();
}

/** Every path in `value` that holds a number — the float-leak detector for test 4. */
function numberPaths(value: unknown, path = "state"): string[] {
  if (typeof value === "number") return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => numberPaths(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => numberPaths(v, `${path}.${k}`));
  }
  return [];
}

/** A result mirroring the SDK's SystemOneResult shape (model · answers · usage). */
function jevResult(opts: {
  model?: string;
  actNow?: number;
  regimeFit?: number | null;
}): JevResult {
  const answers: Record<string, unknown> = {
    act_now: { type: "noul", noul: opts.actNow ?? 0.9 },
  };
  if (opts.regimeFit !== null) {
    const score = opts.regimeFit ?? 1.8;
    answers.regime_fit = {
      type: "score",
      score,
      confidence: 0.85,
      legend: { 0: "Poor fit", 1: "Mixed fit", 2: "Good fit" },
      probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 },
    };
  }
  return {
    model: opts.model ?? JEV_MODEL,
    answers,
    usage: { input_tokens: 412, output_tokens: 0 },
  } as JevResult;
}

// ─── Spec cases ───

describe("toJevRequest — spec cases", () => {
  it("1. HOLD → null, whatever the position (the market says wait; no Jev call)", () => {
    expect(toJevRequest(withVerdict("hold"), FLAT)).toBeNull();
    expect(toJevRequest(withVerdict("hold"), { position: "long" })).toBeNull();
  });

  it("2. unknown verdict → throws with the signal_id in the message", () => {
    const bad = signal({
      signal_id: "test-jev-unknown-042",
      composite_verdict: { verdict: "long" as Verdict, confidence: 0.8 },
    });
    expect(() => toJevRequest(bad, FLAT)).toThrow(/test-jev-unknown-042/);
  });

  it("3a. BUY → exactly act_now + regime_fit; position_conflict is not a question", () => {
    expect(questionIds(withVerdict("buy"))).toEqual(["act_now", "regime_fit"]);
    expect(requestFor(withVerdict("buy")).questions).not.toHaveProperty("position_conflict");
  });

  it("3b. SELL → exactly act_now + regime_fit; position_conflict is not a question", () => {
    expect(questionIds(withVerdict("sell"))).toEqual(["act_now", "regime_fit"]);
    expect(requestFor(withVerdict("sell")).questions).not.toHaveProperty("position_conflict");
  });

  it("3c. regime absent or not a string → act_now only, and state carries no regime", () => {
    for (const regime of [undefined, null, "", 42]) {
      const s = withVerdict("buy", { regime });
      expect(questionIds(s)).toEqual(["act_now"]);
      expect(stateOf(s)).not.toHaveProperty("regime");
    }
  });

  it("4. no raw float reaches state — confidence, venue agreement and price never leak", () => {
    const s = withVerdict("buy", { cross_venue_metadata: CROSS_VENUE });
    const state = stateOf(s);
    const json = JSON.stringify(state);

    expect(json).not.toContain("0.7342"); // composite_verdict.confidence
    expect(json).not.toContain("0.6667"); // venue_agreement_score
    expect(json).not.toContain("83960.6"); // price
    expect(["high", "medium", "low"]).toContain(state.confidence_band);
    expect(numberPaths(state)).toEqual([]);
  });

  it("5. merkle_proof never reaches state, even on a signal that carries one", () => {
    const state = stateOf(withVerdict("buy", { merkle_proof: MERKLE }));
    const json = JSON.stringify(state);

    expect(state).not.toHaveProperty("merkle_proof");
    expect(json).not.toContain(MERKLE.leaf);
    expect(json).not.toContain(MERKLE.root);
  });

  // DRIFT GATE. TypeSafe's model aliases move when a release ships, so answers
  // could change under THRESHOLDS with no change on our side. This test makes a
  // non-versioned model id unmergeable.
  it("6. DRIFT GATE — JEV_MODEL is a pinned jev-X.Y.Z id and every request carries it", () => {
    expect(JEV_MODEL).toMatch(/^jev-\d+\.\d+\.\d+$/);
    expect(requestFor(withVerdict("buy")).model).toBe(JEV_MODEL);
    expect(requestFor(withVerdict("sell")).model).toBe(JEV_MODEL);
  });

  it("7. every confidence bucket is reachable, boundaries included", () => {
    const { high, medium } = THRESHOLDS.band;
    expect(bucketConfidence(1)).toBe("high");
    expect(bucketConfidence(high)).toBe("high");
    expect(bucketConfidence(high - 1e-9)).toBe("medium");
    expect(bucketConfidence(medium)).toBe("medium");
    expect(bucketConfidence(medium - 1e-9)).toBe("low");
    expect(bucketConfidence(0)).toBe("low");

    const bandFor = (confidence: number) =>
      stateOf(signal({ composite_verdict: { verdict: "buy", confidence } })).confidence_band;
    expect(bandFor(high)).toBe("high");
    expect(bandFor(medium)).toBe("medium");
    expect(bandFor(0)).toBe("low");
  });
});

// ─── Input validation ───

describe("toJevRequest — input validation", () => {
  it("bucketConfidence refuses values outside a finite [0, 1]", () => {
    for (const bad of [Number.NaN, -0.01, 1.01, Number.POSITIVE_INFINITY]) {
      expect(() => bucketConfidence(bad)).toThrow();
    }
  });

  it("an out-of-range confidence throws with the signal_id", () => {
    for (const confidence of [Number.NaN, 1.2, -0.5]) {
      const s = signal({
        signal_id: "test-jev-badconf-007",
        composite_verdict: { verdict: "buy", confidence },
      });
      expect(() => toJevRequest(s, FLAT)).toThrow(/test-jev-badconf-007/);
    }
  });

  it("an out-of-range venue_agreement_score throws with the signal_id", () => {
    const s = signal({
      signal_id: "test-jev-badvenue-008",
      cross_venue_metadata: { ...CROSS_VENUE, venue_agreement_score: 1.5 },
    });
    expect(() => toJevRequest(s, FLAT)).toThrow(/test-jev-badvenue-008/);
  });

  it("short and cover are actionable verdicts, not unknown ones", () => {
    expect(questionIds(withVerdict("short"))).toEqual(["act_now", "regime_fit"]);
    expect(questionIds(withVerdict("cover"))).toEqual(["act_now", "regime_fit"]);
  });
});

// ─── state shape ───

describe("toJevRequest — state", () => {
  it("carries exactly the allow-listed keys for a plain BUY", () => {
    expect(Object.keys(stateOf(withVerdict("buy"))).sort()).toEqual([
      "confidence_band",
      "conflicts_with_position",
      "market",
      "position",
      "regime",
      "symbol",
      "timeframe",
      "verdict",
    ]);
  });

  it("maps the envelope fields a question reads", () => {
    expect(stateOf(withVerdict("sell"), { position: "long" })).toEqual({
      symbol: "BTC",
      market: "crypto",
      timeframe: "5m",
      verdict: "sell",
      confidence_band: "high",
      regime: "TRENDING_UP",
      position: "long",
      conflicts_with_position: true,
    });
  });

  it("omits every venue field when cross_venue_metadata is null (the live emitter today)", () => {
    const state = stateOf(withVerdict("buy"));
    expect(state).not.toHaveProperty("venues_consulted");
    expect(state).not.toHaveProperty("venue_agreement_band");
    expect(state).not.toHaveProperty("per_venue_verdicts");
  });

  it("carries the venue fields, agreement bucketed, when cross_venue_metadata is present", () => {
    const state = stateOf(withVerdict("buy", { cross_venue_metadata: CROSS_VENUE }));
    expect(state.venues_consulted).toEqual(["HL", "BINANCE", "BYBIT"]);
    expect(state.venue_agreement_band).toBe("medium");
    expect(state.per_venue_verdicts).toEqual({ HL: "buy", BINANCE: "buy", BYBIT: "hold" });
  });

  it("omits only the band when venue_agreement_score is null", () => {
    const state = stateOf(
      withVerdict("buy", {
        cross_venue_metadata: { venues_consulted: ["HL"], venue_agreement_score: null },
      }),
    );
    expect(state.venues_consulted).toEqual(["HL"]);
    expect(state).not.toHaveProperty("venue_agreement_band");
    expect(state).not.toHaveProperty("per_venue_verdicts");
  });

  it("sends a position on another symbol as flat, so it cannot conflict", () => {
    const other = stateOf(withVerdict("sell"), { position: "long", positionSymbol: "ETH" });
    expect(other.position).toBe("flat");
    expect(other.conflicts_with_position).toBe(false);

    const same = stateOf(withVerdict("sell"), { position: "long", positionSymbol: "BTC" });
    expect(same.position).toBe("long");
    expect(same.conflicts_with_position).toBe(true);
  });
});

// ─── Questions ───

describe("toJevRequest — questions", () => {
  it("act_now is a Noul with a description for each outcome", () => {
    const q = requestFor(withVerdict("buy")).questions.act_now as {
      type: string;
      instructions: unknown;
      criteria: { true?: unknown; false?: unknown };
    };
    expect(q.type).toBe("noul");
    expect(typeof q.instructions).toBe("string");
    expect(typeof q.criteria.true).toBe("string");
    expect(typeof q.criteria.false).toBe("string");
  });

  it("regime_fit is a Score with exactly three ordered levels", () => {
    const q = requestFor(withVerdict("buy")).questions.regime_fit as {
      type: string;
      criteria: unknown[];
    };
    expect(q.type).toBe("score");
    expect(q.criteria).toHaveLength(3);
  });
});

// ─── Position conflict (code-computed, never a Jev question) ───

describe("conflictsWithPosition", () => {
  const table: Array<[Verdict, "long" | "short" | "flat", boolean]> = [
    ["buy", "long", false],
    ["buy", "short", true],
    ["buy", "flat", false],
    ["sell", "long", true],
    ["sell", "short", false],
    ["sell", "flat", false],
    ["short", "long", true],
    ["short", "short", false],
    ["short", "flat", false],
    ["cover", "long", false],
    ["cover", "short", true],
    ["cover", "flat", false],
    ["hold", "long", false],
    ["hold", "short", false],
    ["hold", "flat", false],
  ];

  it.each(table)("%s against a %s position → %s", (verdict, position, expected) => {
    expect(conflictsWithPosition(verdict, position)).toBe(expected);
  });
});

// ─── decide() ───

describe("decide", () => {
  const buyReq = () => requestFor(withVerdict("buy"));

  it("acts when the model is pinned, there is no conflict, the regime fits and act_now clears the bar", () => {
    const d = decide(buyReq(), jevResult({ actNow: 0.9, regimeFit: 1.8 }));
    expect(d.decision).toBe("act");
  });

  it("AC7b model guard: a response from any model other than JEV_MODEL caps at escalate and never throws", () => {
    for (const model of ["typesafe-ai/jev", "jev-1.14.0", ""]) {
      const d = decide(buyReq(), jevResult({ model, actNow: 0.99, regimeFit: 2 }));
      expect(d.decision).toBe("escalate");
    }
    const logged = decide(buyReq(), jevResult({ model: "typesafe-ai/jev", actNow: 0.99 }));
    expect(logged.reasons.join(" ")).toContain("typesafe-ai/jev");
  });

  it("escalates a verdict that conflicts with the open position, whatever act_now says", () => {
    const req = requestFor(withVerdict("sell"), { position: "long" });
    expect(decide(req, jevResult({ actNow: 0.99, regimeFit: 2 })).decision).toBe("escalate");
  });

  it("holds when regime_fit falls below the minimum, and not at it", () => {
    const { min } = THRESHOLDS.regimeFit;
    expect(decide(buyReq(), jevResult({ actNow: 0.9, regimeFit: min - 0.01 })).decision).toBe("hold");
    expect(decide(buyReq(), jevResult({ actNow: 0.9, regimeFit: min })).decision).toBe("act");
  });

  it("maps act_now onto act / escalate / hold, boundaries included", () => {
    const { act, wait } = THRESHOLDS.actNow;
    const at = (actNow: number) => decide(buyReq(), jevResult({ actNow })).decision;
    expect(at(1)).toBe("act");
    expect(at(act)).toBe("act");
    expect(at(act - 0.001)).toBe("escalate");
    expect(at((act + wait) / 2)).toBe("escalate");
    expect(at(wait + 0.001)).toBe("escalate");
    expect(at(wait)).toBe("hold");
    expect(at(0)).toBe("hold");
  });

  it("decides on act_now alone when regime_fit was not asked", () => {
    const req = requestFor(withVerdict("buy", { regime: undefined }));
    expect(decide(req, jevResult({ actNow: 0.9, regimeFit: null })).decision).toBe("act");
  });

  it("escalates, never throws, on malformed answers", () => {
    const req = buyReq();
    const malformed: JevResult[] = [
      { model: JEV_MODEL, answers: {} } as JevResult,
      { model: JEV_MODEL, answers: { act_now: { type: "score", score: 2 } } } as JevResult,
      jevResult({ actNow: Number.NaN }),
      jevResult({ actNow: 1.5 }),
      jevResult({ actNow: 0.9, regimeFit: null }), // regime_fit was asked but not answered
      jevResult({ actNow: 0.9, regimeFit: Number.POSITIVE_INFINITY }),
    ];
    for (const result of malformed) {
      expect(() => decide(req, result)).not.toThrow();
      expect(decide(req, result).decision).toBe("escalate");
    }
  });

  it("escalates, never throws, on a request whose state is not an object", () => {
    const req = { ...buyReq(), state: null };
    expect(() => decide(req, jevResult({}))).not.toThrow();
    expect(decide(req, jevResult({})).decision).toBe("escalate");
  });

  it("THRESHOLDS cannot be mutated at runtime", () => {
    expect(Object.isFrozen(THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(THRESHOLDS.band)).toBe(true);
    expect(Object.isFrozen(THRESHOLDS.actNow)).toBe(true);
    expect(Object.isFrozen(THRESHOLDS.regimeFit)).toBe(true);
  });
});
