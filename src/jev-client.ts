/**
 * Client for the Jev ("System One") API by TypeSafe AI.
 *
 * SCHEMA RECONSTRUCTED FROM PUBLIC EXAMPLES AS OF 2026-10-01. No official
 * documentation was consulted directly to write this file (network access
 * during development was limited to confirming the endpoint exists — see
 * below). Verify the request/response shapes against
 * https://typesafe.ai/docs before relying on this in production.
 *
 * Everything that talks to the network lives in this one file and behind the
 * `JevClient` interface on purpose: if the real API differs from what is
 * assumed here, this is the single place to fix it. `engine.ts` and
 * `telegram-bot.ts` never touch `fetch` or parse Jev's JSON themselves.
 *
 * A real (unauthenticated) request to `POST https://api.typesafe.ai/v1/systemone`
 * made during development returned `HTTP 401` with a body shaped like
 * `{"detail":{"error_type":"authentication_error","message":"..."}}` — which
 * confirms the endpoint exists, but does NOT match the `{ok:false,reason,status}`
 * error envelope described in third-party examples. Because of that
 * discrepancy, `requestOnce()` below derives the error `reason` primarily
 * from the HTTP status code and only trusts a `reason` field in the response
 * body if it is one of the known literals — see `mapStatusToReason()`.
 */

export type JevQuestionType = "yesno" | "score" | "choice";

export interface JevQuestion {
  id: string;
  type: JevQuestionType;
  /** Fixed instructions written by this program. NEVER interpolate untrusted user input here — see engine.ts. */
  instructions: string;
  /** Fixed grading criteria written by this program. NEVER interpolate untrusted user input here — see engine.ts. */
  criteria: string;
  /** Only used for `type: "choice"` questions. */
  options?: string[];
}

export interface JevYesNoAnswer {
  type: "yesno";
  /** Probability in [0, 1] that the answer is "yes". */
  p: number;
}

export interface JevScoreAnswer {
  type: "score";
  /** Score in [0, 1]. */
  score: number;
  level?: string;
  probabilities?: Record<string, number>;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  pTop?: number;
  margin?: number;
  probabilities?: Record<string, number>;
}

export type JevAnswer = JevYesNoAnswer | JevScoreAnswer | JevChoiceAnswer;

export type JevErrorReason =
  | "rejected"
  | "rate_limited"
  | "overloaded"
  | "http_error"
  | "misconfigured"
  | "unreachable"
  | "malformed";

export interface JevSuccessResponse {
  ok: true;
  answers: Record<string, JevAnswer>;
  inputTokens?: number;
  model?: string;
}

export interface JevErrorResponse {
  ok: false;
  reason: JevErrorReason;
  status?: number;
  message?: string;
}

export type JevResponse = JevSuccessResponse | JevErrorResponse;

/**
 * Narrow interface the rest of the app depends on. `engine.ts` is written
 * against this, not against `RealJevClient`, so tests can supply a mock and
 * so an alternative implementation (e.g. a caching wrapper) can be swapped
 * in without touching anything else.
 */
export interface JevClient {
  askJev(questions: JevQuestion[], state: string): Promise<JevResponse>;
}

export interface JevClientOptions {
  apiKey: string;
  /** Default: https://api.typesafe.ai */
  baseUrl?: string;
  /** Default: jev-latest */
  model?: string;
  /** Per-request timeout in ms. Default: 8000. */
  timeoutMs?: number;
  /** How many times to retry on a transient error (rate_limited/overloaded/unreachable). Default: 1. */
  maxRetries?: number;
}

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 400;

const RETRYABLE_REASONS: ReadonlySet<JevErrorReason> = new Set(["rate_limited", "overloaded", "unreachable"]);
const KNOWN_REASONS: ReadonlySet<string> = new Set([
  "rejected",
  "rate_limited",
  "overloaded",
  "http_error",
  "misconfigured",
  "unreachable",
  "malformed",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort mapping from HTTP status to our error taxonomy. Used as a fallback when the response body doesn't carry a recognizable `reason`. */
function mapStatusToReason(status: number): JevErrorReason {
  if (status === 401 || status === 403) return "misconfigured";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "overloaded";
  if (status >= 400) return "http_error";
  return "http_error";
}

function isJevAnswer(value: unknown): value is JevAnswer {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type === "yesno") return typeof v.p === "number";
  if (v.type === "score") return typeof v.score === "number";
  if (v.type === "choice") return typeof v.choice === "string";
  return false;
}

function tryExtractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.message === "string") return b.message;
  if (typeof b.reason === "string" && !KNOWN_REASONS.has(b.reason)) return b.reason;
  const detail = b.detail;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    if (typeof d.message === "string") return d.message;
  }
  return undefined;
}

/** Real implementation, talking to the live Jev API over `fetch`. */
export class RealJevClient implements JevClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly apiKey: string;

  constructor(options: JevClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error("RealJevClient requires a non-empty apiKey");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async askJev(questions: JevQuestion[], state: string): Promise<JevResponse> {
    let lastResponse: JevResponse = { ok: false, reason: "unreachable", message: "no attempt made" };

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
      lastResponse = await this.requestOnce(questions, state);
      if (lastResponse.ok || !RETRYABLE_REASONS.has(lastResponse.reason)) {
        return lastResponse;
      }
    }

    return lastResponse;
  }

  private async requestOnce(questions: JevQuestion[], state: string): Promise<JevResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ state, model: this.model, questions }),
        signal: controller.signal,
      });

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }

      if (res.ok) {
        if (
          body &&
          typeof body === "object" &&
          (body as Record<string, unknown>).ok === true &&
          typeof (body as Record<string, unknown>).answers === "object"
        ) {
          const answersRaw = (body as Record<string, unknown>).answers as Record<string, unknown>;
          const answers: Record<string, JevAnswer> = {};
          for (const [id, value] of Object.entries(answersRaw)) {
            if (isJevAnswer(value)) answers[id] = value;
          }
          const b = body as Record<string, unknown>;
          return {
            ok: true,
            answers,
            inputTokens: typeof b.inputTokens === "number" ? b.inputTokens : undefined,
            model: typeof b.model === "string" ? b.model : undefined,
          };
        }
        return {
          ok: false,
          reason: "malformed",
          status: res.status,
          message: "Jev API returned HTTP 200 but the response body did not match the expected { ok: true, answers } shape.",
        };
      }

      // Non-2xx: trust an explicit, known `reason` in the body if present,
      // otherwise fall back to mapping the HTTP status ourselves (see the
      // module-level comment about the observed 401 body shape).
      const bodyReason =
        body && typeof body === "object" && typeof (body as Record<string, unknown>).reason === "string"
          ? ((body as Record<string, unknown>).reason as string)
          : undefined;
      const reason: JevErrorReason =
        bodyReason && KNOWN_REASONS.has(bodyReason) ? (bodyReason as JevErrorReason) : mapStatusToReason(res.status);

      return {
        ok: false,
        reason,
        status: res.status,
        message: tryExtractMessage(body),
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, reason: "unreachable", message: `Request timed out after ${this.timeoutMs}ms` };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: "unreachable", message };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Builds a `RealJevClient` from `process.env.JEV_API_KEY`, or returns `null` if it is not set. */
export function createJevClientFromEnv(): JevClient | null {
  const apiKey = process.env.JEV_API_KEY?.trim();
  if (!apiKey) return null;
  return new RealJevClient({ apiKey });
}
