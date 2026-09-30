#!/usr/bin/env node
/**
 * `npm start` — the real Telegram bot. Listens to messages in the groups it
 * has been added to, runs them through the moderation engine, and applies
 * the resulting action(s).
 *
 * REQUIRED TELEGRAM PERMISSIONS: the bot must be an *admin* in the group
 * with, at minimum:
 *   - "Delete messages" (for the `delete` action)
 *   - "Ban users"       (for the `mute`/`ban` actions — Telegram exposes
 *                         muting as a restriction, which needs the same
 *                         "Restrict members" admin permission)
 * Without admin rights, `bot.api.deleteMessage` /
 * `restrictChatMember` / `banChatMember` calls will fail; failures are
 * logged and swallowed rather than crashing the bot (see `applyActions`).
 *
 * KNOWN LIMITATION: Telegram's Bot API does not expose a user's account
 * creation date, so `sender.accountAgeDays` is always left `undefined`
 * here. The bot instead tracks, in memory, how many messages it has seen
 * from each user in each chat (`previousMessageCount`), which is a reliable
 * proxy for "this user is brand new to this group" and is what both the
 * heuristic and Jev-backed prompts actually key off of for the "flood"
 * category. This in-memory history resets on restart; swap in a real store
 * (Redis, SQLite, ...) if you need it to survive restarts.
 */
import "dotenv/config";
import { Bot, type Context } from "grammy";
import { createEngine } from "./engine.js";
import { createJevClientFromEnv } from "./jev-client.js";
import { loadRulesConfig } from "./rules.js";
import type { IncomingMessage, ModerationDecision } from "./types.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and fill it in (get a token from @BotFather).");
  process.exit(1);
}

const adminChatId = process.env.ADMIN_CHAT_ID?.trim();
if (!adminChatId) {
  console.warn(
    "ADMIN_CHAT_ID is not set: flag_admin actions will only be logged to the console, not sent to a Telegram chat.",
  );
}

const rules = loadRulesConfig();
const jevClient = createJevClientFromEnv();
const engine = createEngine(rules, jevClient);

console.log(`jev-bouncer starting with the ${engine.kind === "jev" ? "real Jev API" : "local heuristic demo"} engine.`);
if (engine.kind === "heuristic-demo") {
  console.warn(
    "JEV_API_KEY is not set: moderation decisions come from the local heuristic demo engine, not the real Jev API. " +
      "Fine for trying the bot out, not recommended for real moderation — see .env.example.",
  );
}

/** How long a `mute` action restricts the user from sending messages. Adjust to taste. */
const MUTE_DURATION_SECONDS = 60 * 60;

// --- Per-user message history (in-memory; resets on restart) --------------
const messageCountByUser = new Map<string, number>();
const lastTextByUser = new Map<string, string>();

function userKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

// --- Chat admin lookup, cached briefly to avoid hammering the Bot API -----
interface AdminCacheEntry {
  ids: Set<number>;
  expiresAt: number;
}
const adminCache = new Map<number, AdminCacheEntry>();
const ADMIN_CACHE_TTL_MS = 5 * 60 * 1000;

async function isChatAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  const cached = adminCache.get(chatId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.ids.has(userId);
  }
  try {
    const admins = await ctx.api.getChatAdministrators(chatId);
    const ids = new Set(admins.map((a) => a.user.id));
    adminCache.set(chatId, { ids, expiresAt: now + ADMIN_CACHE_TTL_MS });
    return ids.has(userId);
  } catch (err) {
    console.error("Failed to fetch chat administrators; treating sender as non-admin:", err);
    return false;
  }
}

// --- Basic cost/abuse cap on real Jev calls --------------------------------
// Fixed-window counter (not a smooth sliding window) on purpose: it is
// enough to stop a spam wave from generating unbounded Jev usage without
// adding a dependency or persistent storage for an MVP self-hosted bot.
class FixedWindowRateLimiter {
  private count = 0;
  private windowStart = Date.now();

  constructor(private readonly maxPerMinute: number) {}

  tryConsume(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.maxPerMinute) return false;
    this.count += 1;
    return true;
  }
}

const rateLimiter = new FixedWindowRateLimiter(rules.rateLimit.maxJevCallsPerMinute);

const LINK_TEXT_PATTERN = /https?:\/\/|www\.|t\.me\//i;

function messageHasLink(ctx: Context): boolean {
  const msg = ctx.message;
  if (!msg) return false;
  const entities = msg.entities ?? [];
  if (entities.some((e) => e.type === "url" || e.type === "text_link")) return true;
  return LINK_TEXT_PATTERN.test(msg.text ?? "");
}

const bot = new Bot(token);

bot.on("message:text", async (ctx) => {
  const chat = ctx.chat;
  const from = ctx.from;
  if (!chat || !from) return;
  if (chat.type !== "group" && chat.type !== "supergroup") return; // only moderate group chats
  if (from.is_bot) return; // never moderate bots, including this one

  const text = ctx.message.text;
  const key = userKey(chat.id, from.id);
  const previousMessageCount = messageCountByUser.get(key) ?? 0;

  const lastText = lastTextByUser.get(key);
  const isExactRepeat = rules.rateLimit.skipRepeatedMessages && lastText === text;
  lastTextByUser.set(key, text);
  messageCountByUser.set(key, previousMessageCount + 1);

  if (isExactRepeat) return;
  if (text.trim().length < rules.rateLimit.minMessageLength) return;

  if (engine.kind === "jev" && !rateLimiter.tryConsume()) {
    console.warn(
      `Jev rate limit reached (${rules.rateLimit.maxJevCallsPerMinute}/min); skipped message from user ${from.id} in chat ${chat.id}.`,
    );
    return;
  }

  const isAdmin = await isChatAdmin(ctx, chat.id, from.id);

  const incoming: IncomingMessage = {
    text,
    hasLink: messageHasLink(ctx),
    sender: { previousMessageCount, isAdmin },
  };

  let decision: ModerationDecision;
  try {
    decision = await engine.evaluate(incoming);
  } catch (err) {
    console.error("Moderation engine threw an error; taking no action on this message:", err);
    return;
  }

  if (decision.actions.length === 1 && decision.actions[0] === "none") return;

  console.log(
    `[moderation] chat=${chat.id} user=${from.id} actions=${decision.actions.join(",")} reason="${decision.reason}"`,
  );

  await applyActions(ctx, decision);
});

async function applyActions(ctx: Context, decision: ModerationDecision): Promise<void> {
  const chat = ctx.chat;
  const from = ctx.from;
  const message = ctx.message;
  if (!chat || !from || !message) return;

  for (const action of decision.actions) {
    try {
      switch (action) {
        case "delete":
          await ctx.api.deleteMessage(chat.id, message.message_id);
          break;
        case "warn":
          // Deliberately generic: the detailed reason/scores are logged and
          // sent to the admin chat, not to the user, so a spammer probing
          // the bot can't use the warning text to learn how to evade it.
          await ctx.reply(
            "This message was flagged by automated moderation. Repeated violations may lead to removal from the group.",
            { reply_parameters: { message_id: message.message_id } },
          );
          break;
        case "mute":
          await ctx.api.restrictChatMember(
            chat.id,
            from.id,
            { can_send_messages: false },
            { until_date: Math.floor(Date.now() / 1000) + MUTE_DURATION_SECONDS },
          );
          break;
        case "ban":
          await ctx.api.banChatMember(chat.id, from.id);
          break;
        case "flag_admin":
          await notifyAdmin(ctx, decision);
          break;
        case "none":
          break;
      }
    } catch (err) {
      console.error(`Failed to apply action "${action}" in chat ${chat.id} (is the bot an admin?):`, err);
    }
  }
}

async function notifyAdmin(ctx: Context, decision: ModerationDecision): Promise<void> {
  const chat = ctx.chat;
  const from = ctx.from;
  const text = ctx.message?.text ?? "";
  if (!chat || !from) return;

  const scoreLine = Object.entries(decision.scores)
    .map(([category, score]) => `${category}=${score.toFixed(2)}`)
    .join(", ");

  const alert =
    `Moderation alert in "${chat.title ?? chat.id}"\n` +
    `From: ${from.username ? "@" + from.username : from.first_name} (id ${from.id})\n` +
    `Actions: ${decision.actions.join(", ")}\n` +
    `Reason: ${decision.reason}\n` +
    (scoreLine ? `Scores: ${scoreLine}\n` : "") +
    `Message: ${text.slice(0, 500)}`;

  if (!adminChatId) {
    console.warn(`flag_admin fired but ADMIN_CHAT_ID is not set; alert was only logged:\n${alert}`);
    return;
  }

  try {
    await ctx.api.sendMessage(adminChatId, alert);
  } catch (err) {
    console.error("Failed to send admin alert to ADMIN_CHAT_ID:", err);
  }
}

bot.catch((err) => {
  console.error("Unhandled bot error:", err);
});

bot.start();
console.log("jev-bouncer is running. Press Ctrl+C to stop.");
