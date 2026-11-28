import { PROGRAM_SIGN_IN, signInVariables } from "../src/presets.ts";
import { describe, expect, test } from "bun:test";
describe("how a connected model is described", () => {
  test("in plain words: on this computer, hosted, or through a program", async () => {
    const { describeEntry } = await import("../src/create.ts");
    expect(describeEntry({ baseUrl: "http://localhost:1234/v1" })).toBe("On this computer.");
    expect(describeEntry({ baseUrl: "https://x.example/v1" })).toBe("A hosted service.");
    expect(describeEntry({ baseUrl: "nonsense" })).toBe("A hosted service.");
    expect(describeEntry({ command: "x" })).toBe("Through a program you are signed in to.");
    expect(describeEntry({ command: "x", adapter: "codex" })).toBe("Through your ChatGPT plan.");
  });
});


describe("which program gets which sign-in variables", () => {
  const FROM_THE_CLAUDE_CODE_DOCS = {
    "code.claude.com/docs/en/authentication, Authentication precedence": ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    "platform.claude.com/docs/en/manage-claude/wif-reference, environment variables": ["ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE"],
  };
  const FROM_THE_CODEX_SOURCE = {
    "openai/codex 6b7a16f codex-rs/login/src/auth/manager.rs:1049-1051": ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
    "openai/codex 6b7a16f codex-rs/protocol/src/shell_environment.rs:11-12, read in login/src/auth/workload_identity.rs": ["OPENAI_IDENTITY_TOKEN_FILE", "OPENAI_IDENTITY_TOKEN_SOURCE"],
  };

  test("each list is exactly what its maker's own documents or source name", () => {
    expect([...PROGRAM_SIGN_IN.claude].sort()).toEqual(Object.values(FROM_THE_CLAUDE_CODE_DOCS).flat().sort());
    expect([...PROGRAM_SIGN_IN.codex].sort()).toEqual(Object.values(FROM_THE_CODEX_SOURCE).flat().sort());
  });

  test("they go to that maker's program, found by the name of its file; any other program gets none", () => {
    for (const command of ["claude", "/usr/local/bin/claude", "C:\\Users\\a\\claude.exe", "claude.cmd"]) expect(signInVariables(command), command).toEqual(PROGRAM_SIGN_IN.claude);
    for (const command of ["codex", "/opt/bin/codex", "codex.CMD"]) expect(signInVariables(command), command).toEqual(PROGRAM_SIGN_IN.codex);
    for (const command of ["agent-cli", "my-claude-wrapper", "claude-proxy", "codex2", "/home/claude/agent"]) expect(signInVariables(command), command).toEqual([]);
  });
});
