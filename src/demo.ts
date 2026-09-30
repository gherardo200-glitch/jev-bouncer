#!/usr/bin/env node
/**
 * `npm run demo` — shows jev-bouncer making moderation decisions on a
 * handful of realistic sample messages, with zero setup required.
 *
 * - No `JEV_API_KEY` in the environment (the default): uses the local
 *   deterministic heuristic engine from `engine.ts`. No network calls, no
 *   account, nothing to sign up for. This is clearly labeled below.
 * - `JEV_API_KEY` set: uses the exact same decision engine, but backed by a
 *   real call to the Jev API, so you can sanity-check real credentials
 *   without wiring up a Telegram bot first.
 */
import "dotenv/config";
import { createEngine } from "./engine.js";
import { createJevClientFromEnv } from "./jev-client.js";
import { loadRulesConfig } from "./rules.js";
import type { IncomingMessage, ModerationAction } from "./types.js";

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY !== false;

function color(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const bold = (s: string) => color("1", s);
const dim = (s: string) => color("2", s);
const yellow = (s: string) => color("33", s);
const green = (s: string) => color("32", s);
const red = (s: string) => color("31", s);
const magenta = (s: string) => color("35", s);
const cyan = (s: string) => color("36", s);

const ACTION_COLOR: Record<ModerationAction, (s: string) => string> = {
  none: green,
  warn: yellow,
  flag_admin: magenta,
  delete: red,
  mute: red,
  ban: red,
};

interface SampleMessage extends IncomingMessage {
  label: string;
}

const SAMPLES: SampleMessage[] = [
  {
    label: "Legit chat message",
    text: "Ciao a tutti! La camminata di sabato al lago è confermata anche con la pioggia? Io porto il thermos del caffe.",
    hasLink: false,
    sender: { previousMessageCount: 47, accountAgeDays: 410 },
  },
  {
    label: "Legit message with a news link",
    text: "Articolo interessante sul mercato immobiliare a Milano, lo linko qui: https://www.corriere.it/economia/casa-milano-prezzi",
    hasLink: true,
    sender: { previousMessageCount: 22, accountAgeDays: 180 },
  },
  {
    label: "Low-effort spam, brand-new account",
    text: "GUADAGNA SOLDI FACILI DA CASA! Scrivimi in privato ORA per iniziare, posti limitati!",
    hasLink: false,
    sender: { previousMessageCount: 0, accountAgeDays: 0 },
  },
  {
    label: "Unsolicited trading-channel ad",
    text: "Ragazzi, seguite il mio canale di trading: sconto speciale solo per voi, scrivetemi per il codice promo! www.definitely-legit-trading.biz",
    hasLink: true,
    sender: { previousMessageCount: 3, accountAgeDays: 10 },
  },
  {
    label: "Crypto scam with a link",
    text: "Investi solo 100 euro in questo nuovo token: lo raddoppi in 48 ore, rendimento garantito! Dettagli nel canale: t.me/tokenlaunch2026",
    hasLink: true,
    sender: { previousMessageCount: 0, accountAgeDays: 5 },
  },
  {
    label: "Toxic reply to another member",
    text: "Sei un idiota patentato, fai schifo e nessuno ti sopporta piu in questo gruppo.",
    hasLink: false,
    sender: { previousMessageCount: 12, accountAgeDays: 220 },
  },
  {
    label: "Link-spam flood from a fresh account",
    text: "guarda qui, guarda anche qui: bit.ly/offerta1 bit.ly/offerta2 tinyurl.com/offerta3",
    hasLink: true,
    sender: { previousMessageCount: 0, accountAgeDays: 0 },
  },
  {
    label: "Seed-phrase wallet-drain scam",
    text: "ATTENZIONE: sono l'admin ufficiale del gruppo. Il tuo wallet risulta bloccato e perderai tutti i tuoi fondi se non invii la tua seed phrase qui in privato entro 10 minuti.",
    hasLink: false,
    sender: { previousMessageCount: 0, accountAgeDays: 0 },
  },
];

async function main() {
  const rules = loadRulesConfig();
  const jevClient = createJevClientFromEnv();
  const engine = createEngine(rules, jevClient);

  console.log(bold("\njev-bouncer demo\n"));

  if (engine.kind === "heuristic-demo") {
    console.log(
      yellow("DEMO MODE") +
        dim(
          ": no JEV_API_KEY found in the environment. Not calling the real Jev API.\n" +
            "         Using a local, deterministic heuristic engine instead (see src/engine.ts).\n" +
            "         Set JEV_API_KEY (and TELEGRAM_BOT_TOKEN, to run the real bot) — see .env.example.\n",
        ),
    );
  } else {
    console.log(
      cyan("LIVE MODE") + dim(": JEV_API_KEY found. Calling the real Jev API for every sample message below.\n"),
    );
  }

  for (const sample of SAMPLES) {
    const decision = await engine.evaluate(sample);
    const primary = decision.actions[0];
    const actionLabel = decision.actions.join(" + ");
    const paint = ACTION_COLOR[primary] ?? ((s: string) => s);

    console.log(bold(sample.label));
    console.log(dim(`  "${sample.text}"`));
    console.log(
      `  sender: ${sample.sender.previousMessageCount} previous msgs, ` +
        `${sample.sender.accountAgeDays ?? "unknown"} days old account, ` +
        `${sample.hasLink ? "has a link" : "no link"}`,
    );
    console.log(`  -> ${paint(bold(actionLabel))}`);
    console.log(`     ${decision.reason}`);
    if (Object.keys(decision.scores).length > 0) {
      const scoreLine = Object.entries(decision.scores)
        .map(([category, score]) => `${category}=${score.toFixed(2)}`)
        .join("  ");
      console.log(dim(`     scores: ${scoreLine}`));
    }
    console.log("");
  }

  if (engine.kind === "heuristic-demo") {
    console.log(dim("This was the demo engine, not the real Jev API. See README for real setup instructions.\n"));
  }
}

main().catch((err) => {
  console.error(red("Demo failed:"), err);
  process.exitCode = 1;
});
