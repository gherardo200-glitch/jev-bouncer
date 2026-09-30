/**
 * Shared moderation types, used by both `engine.ts` (decision logic) and
 * `rules.ts` (YAML threshold config). Kept in their own module so the two
 * files don't need to import from each other.
 */

/** What the bot can do about a message/user. */
export type ModerationAction = "none" | "warn" | "delete" | "mute" | "ban" | "flag_admin";

/**
 * Moderation categories are plain strings on purpose: the YAML config can
 * introduce a new category without touching any code, and the Jev-backed
 * engine will ask Jev to score whatever category names appear in
 * `config.yml`. The built-in heuristic demo engine (see `engine.ts`) only
 * knows how to score the categories listed in `DEFAULT_CATEGORIES` below and
 * silently skips anything else.
 */
export type ModerationCategory = string;

/** Categories the bundled heuristic demo engine and example prompts cover out of the box. */
export const DEFAULT_CATEGORIES = ["scam", "spam", "ads", "toxicity", "flood"] as const;

export interface SenderContext {
  /** How many messages this user has already sent in this group before this one. */
  previousMessageCount: number;
  /**
   * Account age in days, if known. Telegram does not expose this directly;
   * callers may estimate it (e.g. from `user.id` magnitude, which roughly
   * correlates with signup time) or omit it entirely.
   */
  accountAgeDays?: number;
  /** Group admins are never auto-moderated by either engine; wire this from your bot's admin list. */
  isAdmin?: boolean;
}

export interface IncomingMessage {
  /** Raw message text. Treated as untrusted input everywhere it is used. */
  text: string;
  /** Whether the message contains a link (as detected by the caller, e.g. from Telegram message entities). */
  hasLink: boolean;
  sender: SenderContext;
}

export interface ModerationDecision {
  /**
   * Actions to take, sorted by severity (most severe first, see
   * `ACTION_SEVERITY`). Always non-empty; `["none"]` means "do nothing".
   * Can contain more than one action (e.g. `["delete", "flag_admin"]`) when
   * a rule combines them.
   */
  actions: ModerationAction[];
  /** Short, human-readable explanation, safe to show to an admin or log. */
  reason: string;
  /** Per-category confidence score in [0, 1], as produced by whichever engine ran. */
  scores: Record<string, number>;
  /** Which engine produced this decision. */
  engine: "heuristic-demo" | "jev";
}

export interface ModerationEngine {
  readonly kind: "heuristic-demo" | "jev";
  evaluate(message: IncomingMessage): Promise<ModerationDecision>;
}

/**
 * Relative severity used to pick the "primary" action and to sort combined
 * actions. Deleting a single message is treated as less severe than muting
 * or banning the account that sent it; `flag_admin` alone (no message/user
 * action) sits just above a plain warning.
 */
export const ACTION_SEVERITY: Record<ModerationAction, number> = {
  none: 0,
  warn: 1,
  flag_admin: 2,
  delete: 3,
  mute: 4,
  ban: 5,
};

/** De-duplicates and sorts actions by severity (most severe first). Never returns an empty array. */
export function sortActionsBySeverity(actions: ModerationAction[]): ModerationAction[] {
  const unique = Array.from(new Set(actions));
  unique.sort((a, b) => ACTION_SEVERITY[b] - ACTION_SEVERITY[a]);
  return unique.length > 0 ? unique : ["none"];
}
