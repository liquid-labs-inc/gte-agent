// Central demo gate for the core test suite (Milestone 7). The deterministic
// demo LLM client is opt-in via GTE_AGENT_LLM=demo and tests must never hit
// real provider networks, so the whole suite runs gated by default. Tests
// that exercise the gate itself reassign process.env.GTE_AGENT_LLM locally
// before building their runtime (the gate reads the env at layer build time).
process.env.GTE_AGENT_LLM ??= "demo"
