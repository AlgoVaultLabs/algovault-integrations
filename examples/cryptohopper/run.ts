/**
 * examples/cryptohopper/run.ts
 *
 * End-to-end demo: fetch a verdict from AlgoVault MCP → reshape into
 * Verifiable-Signal v1.0 envelope → curry-bind the Cryptohopper Signaler
 * config → transform → log (dry-run) or GET the Signaler endpoint with
 * HMAC-sha512 signature (live, env-gated).
 *
 * Default behavior: DRY RUN. The full GET URL + the `X-Hub-Signature`
 * header it WOULD send are printed to stdout (with `hmac_secret` redacted).
 * NO live request is made. This is intentional — a live request against
 * a real Signaler account consumes points (10 points per published signal
 * per Cryptohopper's pricing) AND emits the signal to all of that Signaler's
 * subscribers' bots in real time. Use the live mode only when you want to
 * verify the round-trip end-to-end once against a sandbox Signaler.
 *
 * Live opt-in: set `CRYPTOHOPPER_LIVE_POST=1` in the environment.
 *
 * HMAC-sha512 over path-with-query (alphabetical-key URL-encoded) is
 * computed here in run.ts. The transform.ts module stays pure (no `node:crypto`
 * import) per the purity discipline shared across all algovault-integrations
 * examples. The signature is sent as the `X-Hub-Signature` header (raw hex,
 * no `sha512=` prefix per Cryptohopper's PHP verification snippet using
 * `hash_equals(header, hash_hmac('sha512', path_with_query, secret))`).
 *
 * Config resolution (first hit wins per field):
 *   1. process.env.CRYPTOHOPPER_<FIELD>
 *   2. ~/.config/algovault/cryptohopper.env  (KEY=value lines)
 *
 * Required env vars (4): CRYPTOHOPPER_API_KEY, CRYPTOHOPPER_HMAC_SECRET,
 *                        CRYPTOHOPPER_SIGNAL_ID, CRYPTOHOPPER_EXCHANGE.
 * Optional env vars (2): CRYPTOHOPPER_SYMBOL_SUFFIX (default "USDT"),
 *                        CRYPTOHOPPER_LIVE_POST (default unset = dry-run).
 *
 * Friendly error on missing required config; no stack-trace dump.
 *
 * Run:
 *   CRYPTOHOPPER_API_KEY=... CRYPTOHOPPER_HMAC_SECRET=... \
 *     CRYPTOHOPPER_SIGNAL_ID=... CRYPTOHOPPER_EXCHANGE=binance \
 *     npx tsx examples/cryptohopper/run.ts                          # dry-run
 *
 *   CRYPTOHOPPER_*=...  CRYPTOHOPPER_LIVE_POST=1 \
 *     npx tsx examples/cryptohopper/run.ts                          # live GET
 *
 * References:
 *   - Cryptohopper Signaler Guide:
 *     https://docs.cryptohopper.com/docs/marketplace-sellers/signaler-guide/
 *   - AlgoVault Verifiable-Signal Interop Spec v1.0:
 *     https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/blob/main/docs/INTEROP-SPEC-v1.md
 */

import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { reshapeToEnvelope } from "../../shared/lib/reshape-to-envelope.js";
import {
  makeToCryptohopperRequest,
  type CryptohopperConfig,
  type CryptohopperRequest,
} from "./transform.js";

const ALGOVAULT_MCP_URL = "https://api.algovault.com/mcp";
const PROBE_COIN = "BTC";
const PROBE_TIMEFRAME = "5m";
const PROBE_EXCHANGE = "BINANCE";

// Cryptohopper Signaler base host (live-verified 2026-05-25; api.cryptohopper.com
// returns 403 ForbiddenException from AWS API Gateway). The Signaler GET endpoint
// is served from the marketing/app domain.
const CRYPTOHOPPER_BASE = "https://www.cryptohopper.com";
const CRYPTOHOPPER_PATH = "/signal.php";

interface ResolvedConfig extends CryptohopperConfig {}

function readDotEnvFile(): Record<string, string> {
  const fallbackPath = join(homedir(), ".config", "algovault", "cryptohopper.env");
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

  const required = [
    "CRYPTOHOPPER_API_KEY",
    "CRYPTOHOPPER_HMAC_SECRET",
    "CRYPTOHOPPER_SIGNAL_ID",
    "CRYPTOHOPPER_EXCHANGE",
  ];
  const missing = required.filter((k) => !get(k));
  if (missing.length > 0) {
    exitWithMessage(
      `ERROR: missing required env var(s): ${missing.join(", ")}\n` +
        `  Set them in the environment OR in ~/.config/algovault/cryptohopper.env (KEY=value lines).\n` +
        `  Required: ${required.join(", ")}\n` +
        `  See examples/cryptohopper/README.md for config issuance steps.`,
      1,
    );
  }

  return {
    api_key: get("CRYPTOHOPPER_API_KEY")!,
    hmac_secret: get("CRYPTOHOPPER_HMAC_SECRET")!,
    signal_id: get("CRYPTOHOPPER_SIGNAL_ID")!,
    exchange: get("CRYPTOHOPPER_EXCHANGE")!,
    symbol_suffix: get("CRYPTOHOPPER_SYMBOL_SUFFIX") ?? "USDT",
  };
}

/**
 * Build the path-with-query string for HMAC-sha512 signing AND for the
 * GET request URL. Keys are sorted alphabetically + URL-encoded per Q-A.
 *
 * Example input  : { api_key: "abc", signal_id: "42", exchange: "binance",
 *                    market: "BTCUSDT", type: "buy" }
 * Example output : "/signal.php?api_key=abc&exchange=binance&market=BTCUSDT&signal_id=42&type=buy"
 */
function buildPathWithQuery(body: CryptohopperRequest): string {
  const keys = (Object.keys(body) as Array<keyof CryptohopperRequest>).sort();
  const pairs = keys.map(
    (k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(body[k]))}`,
  );
  return `${CRYPTOHOPPER_PATH}?${pairs.join("&")}`;
}

/**
 * Compute HMAC-sha512 over the path-with-query string. Returns raw hex
 * (no `sha512=` prefix per Cryptohopper's PHP verification snippet).
 */
function signRequest(pathWithQuery: string, hmacSecret: string): string {
  return createHmac("sha512", hmacSecret).update(pathWithQuery).digest("hex");
}

// `reshapeToEnvelope` is imported from `shared/lib/reshape-to-envelope.js`
// (hoisted per OPS-SHARED-TS-PRIMITIVES-EXTRACTION-W1; single SoT across all
// TS examples).

async function main(): Promise<void> {
  const config = resolveConfig();
  const liveMode = process.env.CRYPTOHOPPER_LIVE_POST === "1";

  process.stdout.write(`[run] connecting to ${ALGOVAULT_MCP_URL} ...\n`);
  const transport = new StreamableHTTPClientTransport(new URL(ALGOVAULT_MCP_URL));
  const client = new Client(
    { name: "algovault-integrations-cryptohopper-demo", version: "0.1.0" },
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

  const toRequest = makeToCryptohopperRequest({
    api_key: config.api_key,
    hmac_secret: config.hmac_secret,
    signal_id: config.signal_id,
    exchange: config.exchange,
    symbol_suffix: config.symbol_suffix,
  });
  const body = toRequest(envelope);

  if (body == null) {
    process.stdout.write(
      "[run] verdict HOLD; skipping Cryptohopper GET per transform contract (HOLD wastes points).\n",
    );
    return;
  }

  const pathWithQuery = buildPathWithQuery(body);
  const signature = signRequest(pathWithQuery, config.hmac_secret);
  const fullUrl = `${CRYPTOHOPPER_BASE}${pathWithQuery}`;

  if (!liveMode) {
    process.stdout.write(
      "[run] DRY RUN — would GET Cryptohopper Signaler. Set CRYPTOHOPPER_LIVE_POST=1 to actually publish.\n",
    );
    process.stdout.write(`[run] GET ${fullUrl}\n`);
    process.stdout.write(
      `[run] headers: {"X-Hub-Signature":"${signature.slice(0, 16)}…<redacted>","User-Agent":"algovault-integrations-cryptohopper/0.1.0"}\n`,
    );
    process.stdout.write(
      `[run] body (decoded): ${JSON.stringify(body, null, 2)}\n`,
    );
    process.stdout.write(
      `[run] hmac_secret: <redacted; first-4-chars=${config.hmac_secret.slice(0, 4)}…>\n`,
    );
    return;
  }

  process.stdout.write(`[run] LIVE GET → ${fullUrl}\n`);
  const resp = await fetch(fullUrl, {
    method: "GET",
    headers: {
      "X-Hub-Signature": signature,
      "User-Agent": "algovault-integrations-cryptohopper/0.1.0",
    },
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
