import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const original = process.env.MCP_TOOL_PROFILE;

afterEach(() => {
  if (original === undefined) delete process.env.MCP_TOOL_PROFILE;
  else process.env.MCP_TOOL_PROFILE = original;
});

describe("MCP_TOOL_PROFILE", () => {
  it("defaults to balanced", () => {
    delete process.env.MCP_TOOL_PROFILE;
    expect(loadConfig().toolProfile).toBe("balanced");
  });

  it("accepts full", () => {
    process.env.MCP_TOOL_PROFILE = "full";
    expect(loadConfig().toolProfile).toBe("full");
  });

  it("rejects unknown profiles", () => {
    process.env.MCP_TOOL_PROFILE = "unknown";
    expect(() => loadConfig()).toThrow(/MCP_TOOL_PROFILE/);
  });
});
