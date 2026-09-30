import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfigPath, loadRulesConfig, resolveActions, type RulesConfig } from "../src/rules.js";

function writeTempConfig(yaml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jev-bouncer-test-"));
  const file = path.join(dir, "config.yml");
  writeFileSync(file, yaml, "utf8");
  return file;
}

describe("loadRulesConfig", () => {
  it("loads the bundled config.example.yml with the expected default categories", () => {
    const rules = loadRulesConfig();
    expect(Object.keys(rules.categories).sort()).toEqual(["ads", "flood", "scam", "spam", "toxicity"]);
    expect(rules.thresholds.scam.length).toBeGreaterThan(0);
    // Thresholds must be sorted most-severe-first.
    const scamMinScores = rules.thresholds.scam.map((t) => t.minScore);
    expect(scamMinScores).toEqual([...scamMinScores].sort((a, b) => b - a));
  });

  it("resolves to config.example.yml by default", () => {
    expect(defaultConfigPath()).toMatch(/config\.example\.yml$/);
  });

  it("applies default rateLimit values when the section is omitted", () => {
    const file = writeTempConfig(`
categories:
  spam:
    description: "test"
thresholds:
  spam:
    - min_score: 0.5
      actions: [warn]
`);
    const rules = loadRulesConfig(file);
    expect(rules.rateLimit.maxJevCallsPerMinute).toBe(20);
    expect(rules.rateLimit.minMessageLength).toBe(5);
    expect(rules.rateLimit.skipRepeatedMessages).toBe(true);
  });

  it("rejects a config with an unknown action", () => {
    const file = writeTempConfig(`
categories:
  spam:
    description: "test"
thresholds:
  spam:
    - min_score: 0.5
      actions: [nuke_from_orbit]
`);
    expect(() => loadRulesConfig(file)).toThrow(/unknown action/);
  });

  it("rejects a config with an out-of-range min_score", () => {
    const file = writeTempConfig(`
categories:
  spam:
    description: "test"
thresholds:
  spam:
    - min_score: 1.5
      actions: [warn]
`);
    expect(() => loadRulesConfig(file)).toThrow(/min_score/);
  });

  it("rejects a config missing the thresholds section", () => {
    const file = writeTempConfig(`
categories:
  spam:
    description: "test"
`);
    expect(() => loadRulesConfig(file)).toThrow(/thresholds/);
  });
});

describe("resolveActions", () => {
  const rules: RulesConfig = {
    categories: { scam: { description: "" }, spam: { description: "" } },
    thresholds: {
      scam: [
        { minScore: 0.9, actions: ["ban", "flag_admin"] },
        { minScore: 0.5, actions: ["warn"] },
      ],
      spam: [{ minScore: 0.6, actions: ["delete"] }],
    },
    rateLimit: { maxJevCallsPerMinute: 20, minMessageLength: 5, skipRepeatedMessages: true },
  };

  it("returns ['none'] when no category crosses any threshold", () => {
    const result = resolveActions({ scam: 0.1, spam: 0.1 }, rules);
    expect(result.actions).toEqual(["none"]);
    expect(result.firedCategories).toEqual([]);
  });

  it("picks the most severe matching tier per category", () => {
    const result = resolveActions({ scam: 0.95 }, rules);
    expect(result.actions).toEqual(["ban", "flag_admin"]);
  });

  it("falls back to a lower tier when the top tier is not met", () => {
    const result = resolveActions({ scam: 0.6 }, rules);
    expect(result.actions).toEqual(["warn"]);
  });

  it("merges and de-duplicates actions from multiple categories, sorted by severity", () => {
    const result = resolveActions({ scam: 0.6, spam: 0.7 }, rules);
    // scam(0.6) -> warn, spam(0.7) -> delete. delete is more severe than warn.
    expect(result.actions).toEqual(["delete", "warn"]);
  });

  it("respects configurable thresholds: raising min_score stops a rule from firing", () => {
    const stricter: RulesConfig = {
      ...rules,
      thresholds: { ...rules.thresholds, spam: [{ minScore: 0.95, actions: ["delete"] }] },
    };
    const result = resolveActions({ spam: 0.7 }, stricter);
    expect(result.actions).toEqual(["none"]);
  });

  it("ignores categories that have no configured thresholds", () => {
    const result = resolveActions({ toxicity: 0.99 }, rules);
    expect(result.actions).toEqual(["none"]);
  });
});
