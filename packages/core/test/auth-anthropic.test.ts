import { describe, expect, test } from "bun:test"
import { AuthAnthropic } from "@gte-agent/core/auth/anthropic"

describe("AuthAnthropic", () => {
  test("pasted API keys become api_key profiles", () => {
    expect(AuthAnthropic.fromPaste("  sk-ant-api03-abc  ")).toEqual({ type: "api_key", key: "sk-ant-api03-abc" })
  })

  test("pasted setup-tokens become oauth profiles without refresh or expiry", () => {
    expect(AuthAnthropic.fromPaste("sk-ant-oat01-xyz")).toEqual({
      type: "oauth",
      access: "sk-ant-oat01-xyz",
      refresh: "",
      expires: 0,
    })
  })

  test("blank pastes are rejected", () => {
    expect(AuthAnthropic.fromPaste("   ")).toBeUndefined()
    expect(AuthAnthropic.fromPaste("")).toBeUndefined()
  })

  test("api_key profiles authenticate with x-api-key", () => {
    expect(AuthAnthropic.requestHeaders({ type: "api_key", key: "sk-ant-api03-abc" })).toEqual({
      "x-api-key": "sk-ant-api03-abc",
    })
  })

  test("oauth profiles authenticate with a bearer token and the oauth beta header", () => {
    expect(
      AuthAnthropic.requestHeaders({ type: "oauth", access: "sk-ant-oat01-xyz", refresh: "", expires: 0 }),
    ).toEqual({
      authorization: "Bearer sk-ant-oat01-xyz",
      "anthropic-beta": AuthAnthropic.OAUTH_BETA,
    })
  })
})
