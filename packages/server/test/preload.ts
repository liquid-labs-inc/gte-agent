// Central demo gate for the server test suite (Milestone 7). The server now
// composes the gated default session runner (SessionRunnerDefault), so without
// this the suite would take the real provider path; tests must never hit real
// provider networks, so the whole suite runs against the deterministic demo
// client by default. The gate reads the environment at layer build time, so a
// test that needs the real path can reassign process.env.GTE_AGENT_LLM before
// building its server instance.
process.env.GTE_AGENT_LLM ??= "demo"
