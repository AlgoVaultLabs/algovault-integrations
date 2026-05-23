/**
 * examples/3commas/run.ts
 *
 * End-to-end demo: fetch a verdict from AlgoVault MCP → reshape into
 * Verifiable-Signal v1.0 envelope → curry-bind the 3Commas Signal Bot
 * config → transform → log (dry-run) or POST to the bot webhook (live,
 * env-gated).
 *
 * Default behavior: DRY RUN. The request body + the webhook URL it WOULD
 * hit are printed to stdout. NO POST is made to 3Commas. This is
 * intentional — a live POST against a real Signal Bot triggers a real
 * trading action on the bot's configured exchange. Use the live mode only
 * when you want to verify the round-trip end-to-end once against a sandbox
 * bot.
 *
 * Live opt-in: set `THREE_COMMAS_LIVE_POST=1` in the environment.
 *
 * Config resolution (first hit wins per field):
 *   1. process.env.THREE_COMMAS_<FIELD>
 *   2. ~/.config/algovault/3commas.env  (KEY=value lines)
 *
 * Required env vars (3): THREE_COMMAS_WEBHOOK_URL, THREE_COMMAS_SECRET,
 *                        THREE_COMMAS_BOT_UUID.
 * Optional env vars (4): THREE_COMMAS_MAX_LAG (default "300"),
 *                        THREE_COMMAS_TV_EXCHANGE (default "BINANCE"),
 *                        THREE_COMMAS_SYMBOL_SUFFIX (default "USDT.P"),
 *                        THREE_COMMAS_LIVE_POST (default unset = dry-run).
 *
 * Friendly error on missing required config; no stack-trace dump.
 *
 * Run:
 *   THREE_COMMAS_WEBHOOK_URL=... THREE_COMMAS_SECRET=... THREE_COMMAS_BOT_UUID=... \
 *     npx tsx examples/3commas/run.ts                            # dry-run
 *
 *   THREE_COMMAS_*=...  THREE_COMMAS_LIVE_POST=1 \
 *     npx tsx examples/3commas/run.ts                            # live POST
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { reshapeToEnvelope } from "../../shared/lib/reshape-to-envelope.js";
import {
  makeToThreeCommasRequest,
  type ThreeCommasConfig,
} from "./transform.js";

const ALGOVAULT_MCP_URL = "https://api.algovault.com/mcp";
const PROBE_COIN = "BTC";
const PROBE_TIMEFRAME = "5m";
const PROBE_EXCHANGE = "BINANCE";

interface ResolvedConfig extends ThreeCommasConfig {
  webhook_url: string;
}

function readDotEnvFile(): Record<string, string> {
  const fallbackPath = join(homedir(), ".config", "algovault", "3commas.env");
  if (!existsSync(fallbackPath)) {
    return {};
  }
  const contents = readFileSync(fallbackPath, "utf-8");
  const map: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    map[key] = value;
  }
  return map;
}

function exitWithMessage(msg: string, code: number): never {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function resolveConfig(): ResolvedConfig {
  const dotenv = readDotEnvFile();
  const get = (key: string): string | undefined =>
    process.env[key]?.trim() ||
    (dotenv[key] && dotenv[key].trim() !== "" ? dotenv[key] : undefined);

  const required = ["THREE_COMMAS_WEBHOOK_URL", "THREE_COMMAS_SECRET", "THREE_COMMAS_BOT_UUID"];
  const missing = required.filter((k) => !get(k));
  if (missing.length > 0) {
    exitWithMessage(
      `ERROR: missing required env var(s): ${missing.join(", ")}\n` +
        `  Set them in the environment OR in ~/.config/algovault/3commas.env (KEY=value lines).\n` +
        `  Required: ${required.join(", ")}\n` +
        `  See examples/3commas/README.md for config issuance steps.`,
      1,
    );
  }

  return {
    webhook_url: get("THREE_COMMAS_WEBHOOK_URL")!,
    secret: get("THREE_COMMAS_SECRET")!,
    bot_uuid: get("THREE_COMMAS_BOT_UUID")!,
    max_lag: get("THREE_COMMAS_MAX_LAG") ?? "300",
    tv_exchange: get("THREE_COMMAS_TV_EXCHANGE") ?? "BINANCE",
    symbol_suffix: get("THREE_COMMAS_SYMBOL_SUFFIX") ?? "USDT.P",
  };
}

// `reshapeToEnvelope` is imported from `shared/lib/reshape-to-envelope.js`
// (hoisted per OPS-SHARED-TS-PRIMITIVES-EXTRACTION-W1; single SoT across all
// TS examples).

async function main(): Promise<void> {
  const config = resolveConfig();
  const liveMode = process.env.THREE_COMMAS_LIVE_POST === "1";

  process.stdout.write(`[run] connecting to ${ALGOVAULT_MCP_URL} ...\n`);
  const transport = new StreamableHTTPClientTransport(new URL(ALGOVAULT_MCP_URL));
  const client = new Client(
    { name: "algovault-integrations-3commas-demo", version: "0.1.0" },
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
    `[run] envelope: ${JSON.stringify({
      verdict: envelope.action,
      confidence: envelope.composite_verdict.confidence,
      signal_id: envelope.signal_id,
    })}\n`,
  );

  const toRequest = makeToThreeCommasRequest({
    secret: config.secret,
    bot_uuid: config.bot_uuid,
    max_lag: config.max_lag,
    tv_exchange: config.tv_exchange,
    symbol_suffix: config.symbol_suffix,
  });
  const body = toRequest(envelope);

  if (body == null) {
    process.stdout.write(
      "[run] verdict HOLD; skipping 3Commas POST per transform contract.\n",
    );
    return;
  }

  if (!liveMode) {
    const redactedBody = { ...body, secret: "<redacted>" };
    process.stdout.write(
      "[run] DRY RUN — would POST to 3Commas. Set THREE_COMMAS_LIVE_POST=1 to actually post.\n",
    );
    process.stdout.write(`[run] POST ${config.webhook_url}\n`);
    process.stdout.write(`[run] headers: {"Content-Type":"application/json"}\n`);
    process.stdout.write(`[run] body: ${JSON.stringify(redactedBody, null, 2)}\n`);
    return;
  }

  process.stdout.write(`[run] LIVE POST → ${config.webhook_url}\n`);
  const resp = await fetch(config.webhook_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
