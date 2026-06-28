# CrewAI → AlgoVault MCP

Connect a [CrewAI](https://crewai.com) agent to the AlgoVault MCP server with `MCPServerAdapter` from [`crewai-tools`](https://github.com/crewAIInc/crewAI-tools) — AlgoVault's tools become CrewAI tools.

## Install

```bash
pip install crewai crewai-tools
```

## Recipe

```python
from crewai import Agent
from crewai_tools import MCPServerAdapter

server_params = {
    "url": "https://api.algovault.com/mcp",
    "transport": "streamable-http",
    # Keyless free tier works with no headers. To raise limits:
    # "headers": {"Authorization": f"Bearer {ALGOVAULT_API_KEY}"},
}

with MCPServerAdapter(server_params) as tools:   # get_trade_call, get_market_regime, …
    analyst = Agent(
        role="Crypto Signal Analyst",
        goal="Fetch and explain AlgoVault's composite trade calls.",
        backstory="You read AlgoVault's cross-venue verdicts before acting.",
        tools=tools,
    )
    # ... add the agent to a Crew and kick off a task.
```

Run the full example: [`agent.py`](./agent.py).

**Wire it up** — `pip install crewai-tools`, point `MCPServerAdapter` at `api.algovault.com/mcp`, and your crew has cross-venue trade calls.

---
Built by [AlgoVault Labs](https://algovault.com) — The Brain Layer for AI Trading Agents.
