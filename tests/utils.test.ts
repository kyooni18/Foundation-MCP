import { describe, expect, it } from "vitest";
import { boundedRecord, normalizeContent, normalizeTags, secureTokenEqual, sha256, vectorLiteral } from "../src/utils.js";

describe("normalizeContent", () => {
  it("normalizes Unicode, whitespace, and line endings", () => {
    expect(normalizeContent("  한글  \r\n test\tvalue  ")).toBe("한글\ntest value");
  });
});

describe("normalizeTags", () => {
  it("normalizes, deduplicates, and sorts tags", () => {
    expect(normalizeTags([" Project X ", "project x", "Swift"])).toEqual(["project-x", "swift"]);
  });
});

describe("hash and vector helpers", () => {
  it("creates stable hashes", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("formats vectors", () => {
    expect(vectorLiteral([0.25, -1, 3])).toBe("[0.25,-1,3]");
  });
});

describe("secureTokenEqual", () => {
  it("compares tokens without accepting unequal lengths", () => {
    expect(secureTokenEqual("secret", "secret")).toBe(true);
    expect(secureTokenEqual("secret", "secrex")).toBe(false);
    expect(secureTokenEqual("secret", "secret-longer")).toBe(false);
  });
});

describe("boundedRecord", () => {
  it("accepts compact provenance records", () => {
    expect(boundedRecord({ type: "decision", id: "abc" }, "source")).toEqual({ type: "decision", id: "abc" });
  });

  it("rejects oversized strings", () => {
    expect(() => boundedRecord({ detail: "x".repeat(1_001) }, "metadata")).toThrow(/metadata/);
  });
});
