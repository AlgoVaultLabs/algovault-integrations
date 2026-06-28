"""
LangChain / LangGraph → AlgoVault MCP — minimal runnable example.

    pip install langchain-mcp-adapters langchain langgraph
    export ANTHROPIC_API_KEY=...        # your LLM provider key
    python agent.py

Keyless free tier (100 calls/month) — no AlgoVault API key needed.
Built by AlgoVault Labs — The Brain Layer for AI Trading Agents (https://algovault.com).
"""
import asyncio

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain.agents import create_agent

ALGOVAULT = {
    "transport": "http",  # streamable HTTP
    "url": "https://api.algovault.com/mcp",
    # To raise limits beyond the keyless free tier, add:
    # "headers": {"Authorization": f"Bearer {os.environ['ALGOVAULT_API_KEY']}"},
}


async def main() -> None:
    client = MultiServerMCPClient({"algovault": ALGOVAULT})
    tools = await client.get_tools()
    agent = create_agent("anthropic:claude-sonnet-4-5", tools)
    result = await agent.ainvoke(
        {"messages": "What's the AlgoVault trade call for BTC on the 1h?"}
    )
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
