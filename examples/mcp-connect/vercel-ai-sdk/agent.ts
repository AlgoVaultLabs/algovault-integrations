/**
 * Vercel AI SDK → AlgoVault MCP — minimal runnable example.
 *
 *   npm install ai @ai-sdk/mcp
 *   export ANTHROPIC_API_KEY=...        # your LLM provider key
 *   npx tsx agent.ts
 *
 * Keyless free tier (100 calls/month) — no AlgoVault API key needed.
 * Built by AlgoVault Labs — The Brain Layer for AI Trading Agents (https://algovault.com).
 */
import { createMCPClient } from "@ai-sdk/mcp";
import { generateText } from "ai";

async function main(): Promise<void> {
  const client = await createMCPClient({
    transport: {
      type: "http", // streamable HTTP
      url: "https://api.algovault.com/mcp",
      // To raise limits beyond the keyless free tier, add:
      // headers: { Authorization: `Bearer ${process.env.ALGOVAULT_API_KEY}` },
    },
  });

  try {
    const tools = await client.tools();
    const { text } = await generateText({
      model: "anthropic/claude-sonnet-4-5",
      tools,
      prompt: "What's the AlgoVault trade call for BTC on the 1h?",
    });
    console.log(text);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
