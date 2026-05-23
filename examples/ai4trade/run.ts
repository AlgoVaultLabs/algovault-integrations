/**
 * examples/ai4trade/run.ts
 *
 * End-to-end demo: fetch a verdict from AlgoVault MCP → reshape into
 * Verifiable-Signal v1.0 envelope → transform to ai4trade request body
 * → log (dry-run) or POST (live, env-gated).
 *
 * Default behavior: DRY RUN. The request body and headers are printed to
 * stdout. NO POST is made to ai4trade. This is intentional — live POSTs
 * consume points from the operator's ai4trade quota and clutter the agent
 * feed. Use the live mode only when you want to verify the round-trip
 * end-to-end once.
 *
 * Live opt-in: set `AI4TRADE_LIVE_POST=1` in the environment.
 *
 * Bearer token resolution (first hit wins):
 *   1. process.env.AI4TRADE_BEARER
 *   2. ~/.config/algovault/ai4trade-bearer.env (single line: the token)
 *
 * Friendly errors on missing token; no stack-trace dump.
 *
 * Run:
 *   AI4TRADE_BEARER=... npx tsx examples/ai4trade/run.ts                   # dry-run
 *   AI4TRADE_BEARER=... AI4TRADE_LIVE_POST=1 npx tsx examples/ai4trade/run.ts  # live POST
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  toAi4tradeRequest,
  type VerifiableSignalV1,
} from "./transform.js";

const ALGOVAULT_MCP_URL = "https://api.algovault.com/mcp";
const AI4TRADE_ENDPOINT = "https://ai4trade.ai/api/signals/realtime";

const PROBE_COIN = "BTC";
const PROBE_TIMEFRAME = "5m";
const PROBE_EXCHANGE = "BINANCE";

function resolveBearer(): string | null {
  const envToken = process.env.AI4TRADE_BEARER;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }
  const fallbackPath = join(homedir(), ".config", "algovault", "ai4trade-bearer.env");
  if (existsSync(fallbackPath)) {
    const contents = readFileSync(fallbackPath, "utf-8").trim();
    if (contents.length > 0) {
      return contents;
    }
  }
  return null;
}

function exitWithMessage(msg: string, code: number): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

/**
 * Reshape the raw `get_trade_call` response (per crypto-quant-signal-mcp
 * src/index.ts) into a Verifiable-Signal v1.0 envelope per the derivation
 * rules from G1's worked-example fixture.
 *
 * Raw shape keys observed: call, confidence, price, indicators, regime,
 * reasoning, timestamp, coin, timeframe, _algovault.
 */
function reshapeToEnvelope(
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

async function main(): Promise<void> {
  const liveMode = process.env.AI4TRADE_LIVE_POST === "1";
  const bearer = resolveBearer();
  if (bearer == null) {
    exitWithMessage(
      "ERROR: ai4trade Bearer token not found.\n" +
        "  Set AI4TRADE_BEARER env var, OR\n" +
        "  put the token in ~/.config/algovault/ai4trade-bearer.env (chmod 600).\n" +
        "  See examples/ai4trade/README.md for token issuance steps.",
      1,
    );
  }

  process.stdout.write(`[run] connecting to ${ALGOVAULT_MCP_URL} ...\n`);
  const transport = new StreamableHTTPClientTransport(new URL(ALGOVAULT_MCP_URL));
  const client = new Client(
    { name: "algovault-integrations-ai4trade-demo", version: "0.1.0" },
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

  const envelope = reshapeToEnvelope(raw, PROBE_COIN, PROBE_TIMEFRAME);
  process.stdout.write(
    `[run] envelope: ${JSON.stringify({ verdict: envelope.action, confidence: envelope.composite_verdict.confidence, signal_id: envelope.signal_id })}\n`,
  );

  const ai4tradeBody = toAi4tradeRequest(envelope);
  if (ai4tradeBody == null) {
    process.stdout.write(
      "[run] verdict HOLD; skipping ai4trade POST per transform contract.\n",
    );
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${bearer}`,
  };

  if (!liveMode) {
    const redactedHeaders = { ...headers, Authorization: "Bearer <redacted>" };
    process.stdout.write(
      "[run] DRY RUN — would POST to ai4trade. Set AI4TRADE_LIVE_POST=1 to actually post.\n",
    );
    process.stdout.write(`[run] POST ${AI4TRADE_ENDPOINT}\n`);
    process.stdout.write(`[run] headers: ${JSON.stringify(redactedHeaders)}\n`);
    process.stdout.write(`[run] body: ${JSON.stringify(ai4tradeBody, null, 2)}\n`);
    return;
  }

  process.stdout.write(`[run] LIVE POST → ${AI4TRADE_ENDPOINT}\n`);
  const resp = await fetch(AI4TRADE_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(ai4tradeBody),
  });
  const respText = await resp.text();
  process.stdout.write(`[run] HTTP ${resp.status} ${resp.statusText}\n`);
  process.stdout.write(`[run] response: ${respText}\n`);
  if (!resp.ok) {
    process.exit(3);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  exitWithMessage(`ERROR: ${msg}`, 99);
});
