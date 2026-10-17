import type { Logger } from "pino";
import { z } from "zod";

export interface AlerterOptions {
  log: Logger;
  /** Telegram delivery needs both; with either missing alerts are only logged. */
  token?: string;
  chatId?: string;
  /** The same alert key is delivered at most once per cooldown. */
  cooldownMs?: number;
  /** Head lag above this many blocks counts as lagging. */
  headLagBlocks?: number;
  /** ... and alerts once it has lasted this long without dropping back. */
  headLagMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface GateFailureAlert {
  gate: string;
  fromBlock: number;
  toBlock: number;
  detail?: string;
}

export interface HaltAlert {
  chainId: number;
  forkBlock: number;
  finalizedBlock: number;
}

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_HEAD_LAG_BLOCKS = 12;
const DEFAULT_HEAD_LAG_MS = 5 * 60 * 1000;
const SEND_TIMEOUT_MS = 10_000;

// An empty variable in a compose/.env file means "unset".
const blankAsUnset = (v: string) => v.trim() || undefined;
const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().transform(blankAsUnset).optional(),
  TELEGRAM_CHAT_ID: z.string().transform(blankAsUnset).optional(),
  ALERT_COOLDOWN_MS: z.coerce.number().int().positive().default(DEFAULT_COOLDOWN_MS),
  ALERT_HEAD_LAG_BLOCKS: z.coerce.number().int().nonnegative().default(DEFAULT_HEAD_LAG_BLOCKS),
  ALERT_HEAD_LAG_MS: z.coerce.number().int().positive().default(DEFAULT_HEAD_LAG_MS),
});

/**
 * Operator notifications. `alert` never throws and never rejects: a broken Telegram link must not
 * take the indexer down, so failures are logged (with the token redacted) and the key stays
 * eligible to be retried on the next occurrence.
 */
export class Alerter {
  private readonly log: Logger;
  private readonly token: string | undefined;
  private readonly chatId: string | undefined;
  private readonly cooldownMs: number;
  private readonly headLagBlocks: number;
  private readonly headLagMs: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly delivered = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private laggingSince: number | undefined;

  constructor(options: AlerterOptions) {
    this.log = options.log;
    this.token = options.token;
    this.chatId = options.chatId;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.headLagBlocks = options.headLagBlocks ?? DEFAULT_HEAD_LAG_BLOCKS;
    this.headLagMs = options.headLagMs ?? DEFAULT_HEAD_LAG_MS;
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    if (Boolean(this.token) !== Boolean(this.chatId)) {
      this.log.warn("only one of TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID is set; alerts are logged, not sent");
    }
  }

  static fromEnv(env: NodeJS.ProcessEnv, log: Logger): Alerter {
    const e = envSchema.parse(env);
    return new Alerter({
      log,
      token: e.TELEGRAM_BOT_TOKEN,
      chatId: e.TELEGRAM_CHAT_ID,
      cooldownMs: e.ALERT_COOLDOWN_MS,
      headLagBlocks: e.ALERT_HEAD_LAG_BLOCKS,
      headLagMs: e.ALERT_HEAD_LAG_MS,
    });
  }

  /** A reorg reached below the finalized block; the run has stopped. */
  halt(info: HaltAlert): Promise<void> {
    return this.alert("halt", `HALT chain ${info.chainId}: reorg at or below finalized block ${info.finalizedBlock} (fork at ${info.forkBlock} or lower); indexer stopped`);
  }

  gateFailure(info: GateFailureAlert): Promise<void> {
    const detail = info.detail ? `: ${info.detail}` : "";
    return this.alert(`gate:${info.gate}`, `Quality gate "${info.gate}" failed for blocks ${info.fromBlock}-${info.toBlock}${detail}`);
  }

  reconciliationMismatch(info: { fromBlock: number; toBlock: number }): Promise<void> {
    return this.alert("reconciliation", `Reconciliation mismatch in blocks ${info.fromBlock}-${info.toBlock}`);
  }

  runCrash(reason: string): Promise<void> {
    return this.alert("run-crash", `Indexer run crashed: ${reason}`);
  }

  /** Call with each new head-lag reading; alerts once lag has stayed above the threshold for the configured time. */
  async headLag(lagBlocks: number): Promise<void> {
    if (lagBlocks <= this.headLagBlocks) {
      this.laggingSince = undefined;
      return;
    }
    const now = this.now();
    this.laggingSince ??= now;
    if (now - this.laggingSince < this.headLagMs) return;
    await this.alert("head-lag", `Head lag is ${lagBlocks} blocks (limit ${this.headLagBlocks}) for ${Math.round((now - this.laggingSince) / 1000)}s`);
  }

  /** Delivers `text` unless `key` was already delivered within the cooldown. Never rejects. */
  async alert(key: string, text: string): Promise<void> {
    try {
      const last = this.delivered.get(key);
      if (this.inflight.has(key) || (last !== undefined && this.now() - last < this.cooldownMs)) return;
      this.inflight.add(key);
      try {
        this.log.warn({ alert: key }, text);
        if (this.token && this.chatId) await this.sendTelegram(this.token, this.chatId, text);
        this.delivered.set(key, this.now());
      } finally {
        this.inflight.delete(key);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error({ alert: key, err: this.redact(message) }, "alert delivery failed");
    }
  }

  private async sendTelegram(token: string, chatId: string, text: string): Promise<void> {
    const res = await this.doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`telegram responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  private redact(message: string): string {
    return this.token ? message.replaceAll(this.token, "<redacted>") : message;
  }
}
