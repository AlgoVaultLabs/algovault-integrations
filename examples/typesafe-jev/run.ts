/**
 * examples/typesafe-jev/run.ts
 *
 * End-to-end demo: fetch a verdict from AlgoVault MCP → reshape it into a
 * Verifiable-Signal v1.0 envelope → toJevRequest → ask TypeSafe Jev →
 * decide() → log act / hold / escalate next to Jev's raw probabilities.
 *
 * It never places an order and never touches a wallet or an exchange
 * credential. All I/O lives here; transform.ts stays pure.
 *
 * Transport, first match wins. Both live legs use the same @typesafe-ai/sdk
 * client and change only `apiKey` + `baseURL` (Vercel's documented migration):
 *
 *   TYPESAFE_API_KEY    → https://api.typesafe.ai, model jev-1.13.0 (pinned)
 *   AI_GATEWAY_API_KEY  → https://ai-gateway.vercel.sh/typesafe, model
 *                         typesafe-ai/jev. The gateway serves only that
 *                         unversioned id and echoes it back, so decide() caps
 *                         this leg at "escalate".
 *   neither             → dry run: print the request body and exit 0.
 *
 * Flags:
 *   --sample                    use a built-in [SAMPLE] envelope instead of a
 *                               live verdict (no network at all)
 *   --stub-model <id>           answer with fixed [STUB] answers attributed to
 *                               model <id> instead of calling Jev
 *   --position long|short|flat  your open position (default: flat)
 *   --position-symbol <SYM>     the symbol that position is on (default: the
 *                               verdict's symbol)
 *
 * Exit codes: 0 done (a HOLD skip, a dry run and an escalate all count) ·
 * 1 bad flags · 2 unexpected MCP response shape · 3 TypeSafe API error ·
 * 99 unexpected error.
 *
 * Run:
 *   npx tsx examples/typesafe-jev/run.ts                         # dry run
 *   npx tsx examples/typesafe-jev/run.ts --sample                # dry run, no network
 *   npx tsx examples/typesafe-jev/run.ts --sample --stub-model jev-1.13.0
 *   TYPESAFE_API_KEY=... npx tsx examples/typesafe-jev/run.ts --position long
 *
 * References:
 *   - TypeSafe System One API: https://docs.typesafe.ai/api
 *   - Vercel AI Gateway, TypeSafe API: https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
 *   - AlgoVault Verifiable-Signal Interop Spec v1.0:
 *     https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  APIConnectionError,
  APIError,
  TypeSafeClient,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import { reshapeToEnvelope } from "../../shared/lib/reshape-to-envelope.js";
import {
  JEV_MODEL,
  decide,
  toJevRequest,
  type JevResult,
  type JevTradeContext,
  type Position,
  type VerifiableSignalV1,
} from "./transform.js";

const ALGOVAULT_MCP_URL = "https://api.algovault.com/mcp";
const PROBE_COIN = "BTC";
const PROBE_TIMEFRAME = "5m";
const PROBE_EXCHANGE = "BINANCE";

const TYPESAFE_BASE_URL = "https://api.typesafe.ai";
const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/typesafe";
/** The gateway's only Jev id. Unversioned, so decide() never acts on its answers. */
const GATEWAY_MODEL = "typesafe-ai/jev";

/** Illustrative envelope for --sample. Not a live AlgoVault verdict. */
const SAMPLE_ENVELOPE: VerifiableSignalV1 = {
  version: "1.0",
  signal_id: "sample-typesafe-jev-0001",
  emitted_at: "2026-09-21T09:15:00Z",
  market: "crypto",
  action: "buy",
  symbol: "BTC",
  price: null,
  quantity: null,
  timeframe: "5m",
  executed_at: null,
  content: "[SAMPLE] Illustrative envelope for the keyless demo; not a live AlgoVault verdict.",
  composite_verdict: { verdict: "buy", confidence: 0.74 },
  merkle_proof: null,
  cross_venue_metadata: null,
  regime: "TRENDING_UP",
};

interface Options {
  sample: boolean;
  stubModel: string | null;
  ctx: JevTradeContext;
}

type Leg =
  | { kind: "stub"; model: string }
  | { kind: "direct"; apiKey: string }
  | { kind: "gateway"; apiKey: string }
  | { kind: "dry-run" };

function exitWithMessage(msg: string, code: number): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

const USAGE =
  "usage: npx tsx examples/typesafe-jev/run.ts [--sample] [--stub-model <id>] " +
  "[--position long|short|flat] [--position-symbol <SYM>]";

function parseArgs(argv: string[]): Options {
  let sample = false;
  let stubModel: string | null = null;
  let position: Position = "flat";
  let positionSymbol: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        exitWithMessage(`ERROR: ${flag} needs a value.\n${USAGE}`, 1);
      }
      return v;
    };
    if (flag === "--sample") sample = true;
    else if (flag === "--stub-model") stubModel = value();
    else if (flag === "--position-symbol") positionSymbol = value();
    else if (flag === "--position") {
      const v = value();
      if (v !== "long" && v !== "short" && v !== "flat") {
        exitWithMessage(`ERROR: --position must be long, short or flat, got "${v}".\n${USAGE}`, 1);
      }
      position = v;
    } else {
      exitWithMessage(`ERROR: unknown argument "${flag}".\n${USAGE}`, 1);
    }
  }

  const ctx: JevTradeContext =
    positionSymbol === undefined ? { position } : { position, positionSymbol };
  return { sample, stubModel, ctx };
}

function pickLeg(stubModel: string | null): Leg {
  if (stubModel !== null) return { kind: "stub", model: stubModel };
  const direct = process.env.TYPESAFE_API_KEY?.trim();
  if (direct) return { kind: "direct", apiKey: direct };
  const gateway = process.env.AI_GATEWAY_API_KEY?.trim();
  if (gateway) return { kind: "gateway", apiKey: gateway };
  return { kind: "dry-run" };
}

/** Fetch a live verdict from AlgoVault MCP (same handshake as examples/cryptohopper/run.ts). */
async function fetchEnvelope(): Promise<VerifiableSignalV1> {
  process.stdout.write(`[run] connecting to ${ALGOVAULT_MCP_URL} ...\n`);
  const transport = new StreamableHTTPClientTransport(new URL(ALGOVAULT_MCP_URL));
  const client = new Client(
    { name: "algovault-integrations-typesafe-jev-demo", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  process.stdout.write(
    `[run] calling get_trade_call(coin=${PROBE_COIN}, timeframe=${PROBE_TIMEFRAME}, exchange=${PROBE_EXCHANGE}) ...\n`,
  );
  const result = await client.callTool({
    name: "get_trade_call",
    arguments: {
      coin: PROBE_COIN,
      timeframe: PROBE_TIMEFRAME,
      includeReasoning: true,
      exchange: PROBE_EXCHANGE,
    },
  });

  const content = result.content as Array<{ type: string; text: string }> | undefined;
  if (!Array.isArray(content) || content.length === 0 || content[0].type !== "text") {
    await client.close();
    exitWithMessage(
      "ERROR: unexpected MCP response shape; expected result.content[0].type === 'text'.",
      2,
    );
  }
  const raw = JSON.parse(content[0].text) as Record<string, unknown>;
  await client.close();

  // `regime` is not a v1.0 field and reshapeToEnvelope drops it; carry it as a
  // forward-compat key (the schema allows additional properties).
  return { ...reshapeToEnvelope(raw, PROBE_COIN, PROBE_TIMEFRAME), regime: raw.regime };
}

/** Fixed answers for --stub-model, shaped like a real SystemOneResult. Not Jev output. */
function stubResult(model: string, request: SystemOneRequest): JevResult {
  const answers: Record<string, unknown> = { act_now: { type: "noul", noul: 0.82 } };
  if ("regime_fit" in request.questions) {
    answers.regime_fit = {
      type: "score",
      score: 1.8,
      confidence: 0.85,
      legend: { 0: "Poor fit", 1: "Mixed fit", 2: "Good fit" },
      probabilities: { 0: 0.05, 1: 0.1, 2: 0.85 },
    };
  }
  return { model, answers, usage: { input_tokens: 0, output_tokens: 0 } } as JevResult;
}

function describeAnswer(answer: unknown): string {
  if (typeof answer !== "object" || answer === null) return JSON.stringify(answer);
  const a = answer as Record<string, unknown>;
  if (a.type === "noul") return `noul=${String(a.noul)} (probability of yes)`;
  if (a.type === "score") {
    return (
      `score=${String(a.score)} confidence=${String(a.confidence)} ` +
      `probabilities=${JSON.stringify(a.probabilities)}`
    );
  }
  return JSON.stringify(answer);
}

async function main(): Promise<void> {
  const { sample, stubModel, ctx } = parseArgs(process.argv.slice(2));
  const leg = pickLeg(stubModel);

  let envelope: VerifiableSignalV1;
  if (sample) {
    out("[run] [SAMPLE] using the built-in sample envelope; not a live AlgoVault verdict.");
    envelope = SAMPLE_ENVELOPE;
  } else {
    envelope = await fetchEnvelope();
  }
  out(
    `[run] envelope: ${JSON.stringify({
      verdict: envelope.composite_verdict.verdict,
      confidence: envelope.composite_verdict.confidence,
      regime: envelope.regime ?? null,
      signal_id: envelope.signal_id,
    })}`,
  );
  out(`[run] position: ${JSON.stringify(ctx)}`);

  const request = toJevRequest(envelope, ctx);
  if (request === null) {
    out("[run] verdict HOLD; skipping the Jev call (the market says wait).");
    return;
  }

  let result: JevResult;
  switch (leg.kind) {
    case "dry-run":
      out("[run] DRY RUN: no TYPESAFE_API_KEY or AI_GATEWAY_API_KEY set. Nothing is sent.");
      out(`[run] request body (POST ${TYPESAFE_BASE_URL}/v1/systemone):`);
      out(JSON.stringify(request, null, 2));
      return;

    case "stub":
      out(`[run] [STUB] fixed answers attributed to model "${leg.model}"; no call to Jev.`);
      result = stubResult(leg.model, request);
      break;

    case "direct":
    case "gateway": {
      const gateway = leg.kind === "gateway";
      const baseURL = gateway ? GATEWAY_BASE_URL : TYPESAFE_BASE_URL;
      const body = gateway ? { ...request, model: GATEWAY_MODEL } : request;
      out(`[run] transport: ${leg.kind} (${baseURL}, model ${body.model ?? JEV_MODEL})`);
      if (gateway) {
        out("[run] note: the gateway serves only the unversioned model, so decide() caps at escalate.");
      }
      const client = new TypeSafeClient({ apiKey: leg.apiKey, baseURL });
      try {
        result = await client.systemOne(body);
      } catch (err: unknown) {
        if (err instanceof APIError) {
          exitWithMessage(`ERROR: TypeSafe API returned HTTP ${err.status}: ${err.message}`, 3);
        }
        if (err instanceof APIConnectionError) {
          exitWithMessage(`ERROR: could not reach ${baseURL}: ${err.message}`, 3);
        }
        throw err;
      }
      break;
    }
  }

  out(`[run] answered by model: ${result.model}`);
  for (const [id, answer] of Object.entries(result.answers)) {
    out(`[run]   ${id}: ${describeAnswer(answer)}`);
  }

  const { decision, reasons } = decide(request, result);
  out(`[run] decision: ${decision.toUpperCase()}`);
  for (const reason of reasons) out(`[run]   - ${reason}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  exitWithMessage(`ERROR: ${msg}`, 99);
});
