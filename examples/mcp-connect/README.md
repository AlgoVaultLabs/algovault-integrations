# examples/mcp-connect

Connect an agent framework directly to the **AlgoVault MCP server** (`https://api.algovault.com/mcp`) — no package, no transformer, ~5 lines. These frameworks consume a remote streamable-HTTP MCP server natively, so AlgoVault's tools (`get_trade_call`, `get_trade_signal`, `get_market_regime`, `scan_funding_arb`) show up as agent tools automatically.

| Framework | Recipe | Client |
|---|---|---|
| [LangChain / LangGraph](./langchain/) | [`langchain/`](./langchain/) | `MultiServerMCPClient` → `get_tools()` |
| [Vercel AI SDK](./vercel-ai-sdk/) | [`vercel-ai-sdk/`](./vercel-ai-sdk/) | `createMCPClient` → `tools()` |
| [CrewAI](./crewai/) | [`crewai/`](./crewai/) | `MCPServerAdapter` (context manager) |

**Keyless free tier** (100 calls/month) — no API key required. To raise limits, pass an `Authorization: Bearer <ALGOVAULT_API_KEY>` header (shown commented-out in each recipe).

> For [Coinbase AgentKit](https://github.com/coinbase/agentkit) — which can't consume a remote MCP server natively — use the [`examples/agentkit/`](../agentkit/) action-provider package instead.

**Pick your framework and wire it up** — your agent is one MCP connection away from cross-venue trade calls.

---
Built by [AlgoVault Labs](https://algovault.com) — The Brain Layer for AI Trading Agents.
