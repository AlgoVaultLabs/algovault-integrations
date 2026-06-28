# examples/agentkit

[Coinbase AgentKit](https://github.com/coinbase/agentkit) — give any AgentKit agent native access to AlgoVault's signal tools via the **`agentkit-algovault`** action provider.

AgentKit is the one framework in this folder set that can't consume a remote MCP server natively (its MCP support is export-only), so AlgoVault ships a thin **action provider** for it: [`agentkit-algovault`](https://github.com/AlgoVaultLabs/agentkit-algovault) (on npm). It is walletless, read-only, and delegates to the AlgoVault MCP server (`api.algovault.com/mcp`).

## Install

```bash
npm install agentkit-algovault @coinbase/agentkit
```

## Use

```ts
import { AgentKit } from "@coinbase/agentkit";
import { algoVaultActionProvider } from "agentkit-algovault";

const agentKit = await AgentKit.from({
  walletProvider, // your existing wallet provider — AlgoVault itself needs no wallet
  actionProviders: [
    algoVaultActionProvider(), // keyless free tier (100 calls/month)
  ],
});
```

The agent now has `get_trade_call`, `get_trade_signal`, `get_market_regime`, and `scan_funding_arb`. Ask it `"AlgoVault trade call for BTC"` and it returns the composite BUY / SELL / HOLD verdict with confidence, regime, and reasoning.

Keyless by default; set `ALGOVAULT_API_KEY` to raise limits, or `ALGOVAULT_MCP_URL` to override the endpoint. The action table, how-it-works, and a version-sync canary live in the [`agentkit-algovault` repo](https://github.com/AlgoVaultLabs/agentkit-algovault).

**Get a verdict now:** `npm i agentkit-algovault`, drop `algoVaultActionProvider()` into your agent, and ask it for a trade call.

---
Built by [AlgoVault Labs](https://algovault.com) — The Brain Layer for AI Trading Agents.
