import pino from "pino";
import { describe, expect, it } from "vitest";
import { Alerter } from "../src/alerts.ts";

const TOKEN = "123456:SECRET-token_abc";
const MINUTE = 60_000;

interface Sent {
  url: string;
  body: { chat_id: string; text: string };
}

function setup(options: { token?: string; chatId?: string; respond?: () => Response | Promise<Response> } = {}) {
  let now = 1_000_000;
  const sent: Sent[] = [];
  const lines: string[] = [];
  const log = pino({ level: "info" }, { write: (line: string) => void lines.push(line) });
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Sent["body"] });
    return options.respond ? options.respond() : new Response("{}", { status: 200 });
  }) as typeof fetch;
  const alerter = new Alerter({
    log,
    token: "token" in options ? options.token : TOKEN,
    chatId: "chatId" in options ? options.chatId : "-1001",
    fetch: fakeFetch,
    now: () => now,
    cooldownMs: 30 * MINUTE,
    headLagBlocks: 10,
    headLagMs: 5 * MINUTE,
  });
  return { alerter, sent, lines, advance: (ms: number) => (now += ms) };
}

describe("Alerter delivery", () => {
  it("posts to the Bot API with the chat id and text", async () => {
    const { alerter, sent } = setup();
    await alerter.runCrash("boom");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(sent[0]?.body.chat_id).toBe("-1001");
    expect(sent[0]?.body.text).toContain("boom");
  });

  it("sends a given key once per cooldown and again after it, independently per key", async () => {
    const { alerter, sent, advance } = setup();
    await alerter.runCrash("first");
    advance(29 * MINUTE);
    await alerter.runCrash("second");
    await alerter.halt({ chainId: 1, forkBlock: 100, finalizedBlock: 120 });
    expect(sent.map((s) => s.body.text.split(" ")[0])).toEqual(["Indexer", "HALT"]);
    advance(MINUTE);
    await alerter.runCrash("third");
    expect(sent).toHaveLength(3);
    expect(sent[2]?.body.text).toContain("third");
  });

  it("tells the operator which halt blocks the start and how to release it", async () => {
    const { alerter, sent } = setup();
    await alerter.haltUnacknowledged({ chainId: 1, reorgId: 7 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.text).toContain("reorg #7");
    expect(sent[0]?.body.text).toContain("ack-halt 7");
  });

  it("dedups gate failures per gate, not per range", async () => {
    const { alerter, sent } = setup();
    await alerter.gateFailure({ gate: "row_counts", fromBlock: 0, toBlock: 99 });
    await alerter.gateFailure({ gate: "row_counts", fromBlock: 100, toBlock: 199 });
    await alerter.gateFailure({ gate: "no_duplicates", fromBlock: 100, toBlock: 199, detail: "3 rows" });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body.text).toContain("no_duplicates");
    expect(sent[1]?.body.text).toContain("3 rows");
  });

  it("collapses concurrent alerts for the same key into one request", async () => {
    const { alerter, sent } = setup();
    await Promise.all([alerter.reconciliationMismatch({ fromBlock: 1, toBlock: 2 }), alerter.reconciliationMismatch({ fromBlock: 3, toBlock: 4 })]);
    expect(sent).toHaveLength(1);
  });

  it("never throws on network failure, keeps the token out of logs, and retries on the next occurrence", async () => {
    let fail = true;
    const { alerter, sent, lines } = setup({
      respond: () => {
        if (fail) throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/sendMessage`);
        return new Response("{}");
      },
    });
    await expect(alerter.runCrash("boom")).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes("alert delivery failed"))).toBe(true);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).toContain("<redacted>");

    // The failed delivery did not start a cooldown.
    fail = false;
    await alerter.runCrash("boom");
    expect(sent).toHaveLength(2);
    await alerter.runCrash("boom");
    expect(sent).toHaveLength(2);
  });

  it("treats a non-2xx Telegram response as a failed delivery", async () => {
    let status = 401;
    const { alerter, sent, lines } = setup({ respond: () => new Response('{"ok":false,"description":"Unauthorized"}', { status }) });
    await expect(alerter.runCrash("boom")).resolves.toBeUndefined();
    expect(lines.join("\n")).toContain("telegram responded 401");
    status = 200;
    await alerter.runCrash("boom");
    expect(sent).toHaveLength(2);
  });

  it.each([
    ["no credentials", { token: undefined, chatId: undefined }],
    ["token only", { chatId: undefined }],
    ["chat id only", { token: undefined }],
  ])("only logs (still deduped) with %s", async (_name, options) => {
    const { alerter, sent, lines } = setup(options);
    await alerter.runCrash("boom");
    await alerter.runCrash("boom");
    expect(sent).toHaveLength(0);
    expect(lines.filter((l) => l.includes("Indexer run crashed: boom"))).toHaveLength(1);
  });
});

describe("Alerter head lag", () => {
  it("alerts only after lag stays above the threshold for the full duration", async () => {
    const { alerter, sent, advance } = setup();
    await alerter.headLag(11);
    advance(4 * MINUTE + 59_000);
    await alerter.headLag(50);
    expect(sent).toHaveLength(0);
    advance(1_000);
    await alerter.headLag(12);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.text).toContain("12 blocks");
  });

  it("restarts the timer when lag recovers, and a lag exactly at the threshold is not lagging", async () => {
    const { alerter, sent, advance } = setup();
    await alerter.headLag(20);
    advance(4 * MINUTE);
    await alerter.headLag(10);
    advance(4 * MINUTE);
    await alerter.headLag(20);
    advance(4 * MINUTE);
    await alerter.headLag(20);
    expect(sent).toHaveLength(0);
    advance(MINUTE);
    await alerter.headLag(20);
    expect(sent).toHaveLength(1);
  });

  it("does not repeat inside the cooldown while lag persists", async () => {
    const { alerter, sent, advance } = setup();
    await alerter.headLag(20);
    advance(5 * MINUTE);
    await alerter.headLag(20);
    for (let i = 0; i < 5; i++) {
      advance(MINUTE);
      await alerter.headLag(20);
    }
    expect(sent).toHaveLength(1);
  });
});

describe("Alerter.fromEnv", () => {
  it("treats blank Telegram variables as unset and applies defaults", async () => {
    const lines: string[] = [];
    const log = pino({ level: "info" }, { write: (line: string) => void lines.push(line) });
    const alerter = Alerter.fromEnv({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: " " }, log);
    await alerter.runCrash("x");
    expect(lines.filter((l) => l.includes("alert delivery failed"))).toHaveLength(0);
    expect(lines.filter((l) => l.includes("only one of"))).toHaveLength(0);
  });

  it("rejects a non-numeric cooldown", () => {
    expect(() => Alerter.fromEnv({ ALERT_COOLDOWN_MS: "soon" }, pino({ level: "silent" }))).toThrow();
  });
});
