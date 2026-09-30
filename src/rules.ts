/**
 * Loads and validates the moderation rules from a YAML file (see
 * `config.example.yml`). The goal is that a non-programmer admin can open
 * that file and tune thresholds without touching any TypeScript.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { type ModerationAction, sortActionsBySeverity } from "./types.js";

export interface ThresholdRule {
  minScore: number;
  actions: ModerationAction[];
}

export interface RateLimitConfig {
  /** Hard cap on how many times per minute the bot will call the real Jev API (across the whole process). */
  maxJevCallsPerMinute: number;
  /** Messages shorter than this (in characters) are never scored at all. */
  minMessageLength: number;
  /** If true, an identical consecutive message from the same user is not re-evaluated. */
  skipRepeatedMessages: boolean;
}

export interface RulesConfig {
  categories: Record<string, { description: string }>;
  /** category -> list of { minScore, actions }, sorted most severe (highest minScore) first. */
  thresholds: Record<string, ThresholdRule[]>;
  rateLimit: RateLimitConfig;
}

const VALID_ACTIONS: ReadonlySet<string> = new Set<ModerationAction>([
  "none",
  "warn",
  "delete",
  "mute",
  "ban",
  "flag_admin",
]);

function repoRoot(): string {
  // This file lives at <repoRoot>/src/rules.ts (or <repoRoot>/dist/rules.js
  // once built), so the repo root is always one directory up.
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..");
}

/**
 * Resolution order: `JEV_BOUNCER_CONFIG` env var > `config.yml` in the repo
 * root (a real deployment's own copy, gitignored) > the bundled
 * `config.example.yml` (sane defaults, safe to ship and run out of the box).
 */
export function defaultConfigPath(): string {
  const custom = process.env.JEV_BOUNCER_CONFIG;
  if (custom) return path.resolve(custom);
  const root = repoRoot();
  const userConfig = path.join(root, "config.yml");
  if (existsSync(userConfig)) return userConfig;
  return path.join(root, "config.example.yml");
}

export function loadRulesConfig(filePath: string = defaultConfigPath()): RulesConfig {
  const raw = readFileSync(filePath, "utf8");
  const parsed = parseYaml(raw);
  return validateRulesConfig(parsed, filePath);
}

function fail(filePath: string, detail: string): never {
  throw new Error(`Invalid rules config at ${filePath}: ${detail}`);
}

function validateRulesConfig(parsed: unknown, filePath: string): RulesConfig {
  if (!parsed || typeof parsed !== "object") {
    fail(filePath, "expected a YAML object at the top level");
  }
  const data = parsed as Record<string, unknown>;

  const categories = parseCategories(data.categories, filePath);
  const thresholds = parseThresholds(data.thresholds, filePath);
  const rateLimit = parseRateLimit(data.rateLimit, filePath);

  return { categories, thresholds, rateLimit };
}

function parseCategories(raw: unknown, filePath: string): Record<string, { description: string }> {
  if (!raw || typeof raw !== "object") {
    fail(filePath, 'missing "categories" section');
  }
  const categories: Record<string, { description: string }> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const description =
      value && typeof value === "object" && typeof (value as Record<string, unknown>).description === "string"
        ? ((value as Record<string, unknown>).description as string)
        : "";
    categories[name] = { description };
  }
  if (Object.keys(categories).length === 0) {
    fail(filePath, '"categories" must define at least one category');
  }
  return categories;
}

function parseThresholds(raw: unknown, filePath: string): Record<string, ThresholdRule[]> {
  if (!raw || typeof raw !== "object") {
    fail(filePath, 'missing "thresholds" section');
  }
  const thresholds: Record<string, ThresholdRule[]> = {};
  for (const [category, rulesValue] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rulesValue)) {
      fail(filePath, `thresholds.${category} must be a list`);
    }
    const parsedRules: ThresholdRule[] = (rulesValue as unknown[]).map((entry, index) =>
      parseThresholdRule(entry, category, index, filePath),
    );
    // Sort most severe threshold first so `resolveActions` can take the first match.
    parsedRules.sort((a, b) => b.minScore - a.minScore);
    thresholds[category] = parsedRules;
  }
  return thresholds;
}

function parseThresholdRule(entry: unknown, category: string, index: number, filePath: string): ThresholdRule {
  const e = (entry ?? {}) as Record<string, unknown>;
  const minScore = Number(e.min_score);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    fail(filePath, `thresholds.${category}[${index}].min_score must be a number between 0 and 1`);
  }
  const actionsRaw = e.actions;
  if (!Array.isArray(actionsRaw) || actionsRaw.length === 0) {
    fail(filePath, `thresholds.${category}[${index}].actions must be a non-empty list`);
  }
  const actions = (actionsRaw as unknown[]).map((a) => {
    if (typeof a !== "string" || !VALID_ACTIONS.has(a)) {
      fail(filePath, `thresholds.${category}[${index}] has an unknown action "${String(a)}"`);
    }
    return a as ModerationAction;
  });
  return { minScore, actions };
}

function parseRateLimit(raw: unknown, filePath: string): RateLimitConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rateLimit: RateLimitConfig = {
    maxJevCallsPerMinute: Number(r.maxJevCallsPerMinute ?? 20),
    minMessageLength: Number(r.minMessageLength ?? 5),
    skipRepeatedMessages: r.skipRepeatedMessages === undefined ? true : Boolean(r.skipRepeatedMessages),
  };
  if (!Number.isFinite(rateLimit.maxJevCallsPerMinute) || rateLimit.maxJevCallsPerMinute <= 0) {
    fail(filePath, "rateLimit.maxJevCallsPerMinute must be a positive number");
  }
  if (!Number.isFinite(rateLimit.minMessageLength) || rateLimit.minMessageLength < 0) {
    fail(filePath, "rateLimit.minMessageLength must be a non-negative number");
  }
  return rateLimit;
}

export interface ResolvedActions {
  actions: ModerationAction[];
  firedCategories: Array<{ category: string; score: number; minScore: number }>;
}

/**
 * Applies the configured thresholds to a set of per-category scores. For
 * each category with a score, the first (most severe) threshold whose
 * `minScore` is met fires and contributes its actions. Actions from every
 * category that fired are merged and sorted by severity.
 */
export function resolveActions(scores: Record<string, number>, rules: RulesConfig): ResolvedActions {
  const collected: ModerationAction[] = [];
  const firedCategories: ResolvedActions["firedCategories"] = [];

  for (const [category, score] of Object.entries(scores)) {
    const tiers = rules.thresholds[category];
    if (!tiers) continue;
    const matched = tiers.find((tier) => score >= tier.minScore);
    if (matched) {
      collected.push(...matched.actions);
      firedCategories.push({ category, score, minScore: matched.minScore });
    }
  }

  if (collected.length === 0) {
    return { actions: ["none"], firedCategories: [] };
  }
  return { actions: sortActionsBySeverity(collected), firedCategories };
}
