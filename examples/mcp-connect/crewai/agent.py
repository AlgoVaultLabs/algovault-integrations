"""
CrewAI → AlgoVault MCP — minimal runnable example.

    pip install crewai crewai-tools
    export ANTHROPIC_API_KEY=...        # your LLM provider key
    python agent.py

Keyless free tier (100 calls/month) — no AlgoVault API key needed.
Built by AlgoVault Labs — The Brain Layer for AI Trading Agents (https://algovault.com).
"""
from crewai import Agent, Crew, Task
from crewai_tools import MCPServerAdapter

server_params = {
    "url": "https://api.algovault.com/mcp",
    "transport": "streamable-http",
    # To raise limits beyond the keyless free tier, add:
    # "headers": {"Authorization": f"Bearer {os.environ['ALGOVAULT_API_KEY']}"},
}


def main() -> None:
    with MCPServerAdapter(server_params) as tools:
        analyst = Agent(
            role="Crypto Signal Analyst",
            goal="Fetch and explain AlgoVault's composite trade calls.",
            backstory="You read AlgoVault's cross-venue verdicts before acting.",
            tools=tools,
        )
        task = Task(
            description="Get the AlgoVault trade call for BTC on the 1h and summarize it.",
            expected_output="The BUY/SELL/HOLD verdict, confidence, regime, and a one-line rationale.",
            agent=analyst,
        )
        crew = Crew(agents=[analyst], tasks=[task])
        print(crew.kickoff())


if __name__ == "__main__":
    main()
