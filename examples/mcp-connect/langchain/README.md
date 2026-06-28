# LangChain / LangGraph → AlgoVault MCP

Connect a LangChain (or LangGraph) agent to the AlgoVault MCP server with [`langchain-mcp-adapters`](https://github.com/langchain-ai/langchain-mcp-adapters) — AlgoVault's tools become LangChain tools.

## Install

```bash
pip install langchain-mcp-adapters langchain langgraph
```

## Recipe

```python
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain.agents import create_agent

client = MultiServerMCPClient(
    {
        "algovault": {
            "transport": "http",  # streamable HTTP
            "url": "https://api.algovault.com/mcp",
            # Keyless free tier works with no headers. To raise limits:
            # "headers": {"Authorization": f"Bearer {ALGOVAULT_API_KEY}"},
        }
    }
)

tools = await client.get_tools()                      # get_trade_call, get_market_regime, …
agent = create_agent("anthropic:claude-sonnet-4-5", tools)
result = await agent.ainvoke({"messages": "What's the AlgoVault trade call for BTC?"})
print(result["messages"][-1].content)
```

Run the full example: [`agent.py`](./agent.py).

**Wire it up** — `pip install langchain-mcp-adapters`, point it at `api.algovault.com/mcp`, and your agent has cross-venue trade calls.

---
Built by [AlgoVault Labs](https://algovault.com) — The Brain Layer for AI Trading Agents.
