# Vercel AI SDK → AlgoVault MCP

Connect a [Vercel AI SDK](https://ai-sdk.dev) agent to the AlgoVault MCP server with `createMCPClient` — AlgoVault's tools become AI SDK tools.

## Install

```bash
npm install ai @ai-sdk/mcp
```

## Recipe

```ts
import { createMCPClient } from "@ai-sdk/mcp";
import { generateText } from "ai";

const client = await createMCPClient({
  transport: {
    type: "http", // streamable HTTP
    url: "https://api.algovault.com/mcp",
    // Keyless free tier works with no headers. To raise limits:
    // headers: { Authorization: `Bearer ${process.env.ALGOVAULT_API_KEY}` },
  },
});

try {
  const tools = await client.tools(); // get_trade_call, get_market_regime, …
  const { text } = await generateText({
    model: "anthropic/claude-sonnet-4-5",
    tools,
    prompt: "What's the AlgoVault trade call for BTC?",
  });
  console.log(text);
} finally {
  await client.close();
}
```

Run the full example: [`agent.ts`](./agent.ts).

> The AI SDK MCP client is lightweight (no server→client push). That's fine here — AlgoVault delivers push via webhook / Telegram, not MCP SSE.

**Wire it up** — `npm i @ai-sdk/mcp`, point it at `api.algovault.com/mcp`, and your agent has cross-venue trade calls.

---
Built by [AlgoVault Labs](https://algovault.com) — The Brain Layer for AI Trading Agents.
