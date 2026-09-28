import { and, asc, count, eq, gte, inArray, lt, min } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../../drizzle/schema";
import { getDb } from "../_core/database";
import { isAutopilotGloballyPaused } from "./autonomyState";

export interface ClaimedJob {
  id: string;
  workspaceId: string;
  type: string;
  payload: unknown;
  attempts: number;
}

export type JobHandler = (payload: any, job: ClaimedJob) => Promise<unknown>;

const handlers = new Map<string, JobHandler>();

export function registerJob(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export async function enqueueJob(input: {
  workspaceId: string;
  type: string;
  payload?: unknown;
  runAfter?: Date;
}): Promise<string> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const id = nanoid();
  await db.insert(schema.jobRuns).values({
    id,
    workspaceId: input.workspaceId,
    type: input.type,
    status: "queued",
    payload: input.payload ?? null,
    runAfter: input.runAfter ?? new Date(),
  });
  return id;
}

export async function getJob(id: string) {
  const db = getDb();
  if (!db) return null;
  const [row] = await db.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, id)).limit(1);
  return row ?? null;
}

const MAX_ATTEMPTS = 3;

/**
 * How long a `running` row may go unclaimed before we assume the worker that took
 * it died mid-job. One constant, because the reclaim path and the monitor must
 * agree: a monitor counting rows the worker would still have recovered by itself
 * reports failures that never happened.
 */
export const RECLAIM_WINDOW_MS = 10 * 60_000;

/** Claim and run a single due job. Returns true if a job was processed. */
export async function runNextJob(now = new Date()): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  // The master switch is checked here as well as in isAutopilotEnabled(), and
  // the two are not redundant: that one only prevents *new* follow-ups from
  // being queued. Pausing has to stop work that is already in the queue too,
  // otherwise an operator pulling the lever mid-burst would watch the remaining
  // emails go out anyway. Jobs stay `queued` and run on resume.
  //
  // Deliberately read on every claim and not cached: a lever that stops sending
  // must not lag, and this is one single-row primary-key lookup.
  if (await isAutopilotGloballyPaused()) return false;

  // Recover jobs stuck in "running" for > 10 min (crashed worker).
  await db
    .update(schema.jobRuns)
    .set({ status: "queued", claimedAt: null })
    .where(
      and(
        eq(schema.jobRuns.status, "running"),
        lt(schema.jobRuns.claimedAt, new Date(now.getTime() - RECLAIM_WINDOW_MS)),
      ),
    );

  const due = await db
    .select({
      id: schema.jobRuns.id,
      workspaceId: schema.jobRuns.workspaceId,
      type: schema.jobRuns.type,
      status: schema.jobRuns.status,
      payload: schema.jobRuns.payload,
      attempts: schema.jobRuns.attempts,
      runAfter: schema.jobRuns.runAfter,
    })
    .from(schema.jobRuns)
    .where(
      and(
        eq(schema.jobRuns.status, "queued"),
        inArray(
          schema.jobRuns.type,
          handlers.size ? [...handlers.keys()] : ["__none__"],
        ),
      ),
    )
    .orderBy(asc(schema.jobRuns.runAfter))
    .limit(5);

  for (const job of due) {
    if (job.runAfter && job.runAfter > now) continue;
    // Atomic claim: only proceed if we flip queued -> running.
    const [claim] = (await db
      .update(schema.jobRuns)
      .set({ status: "running", claimedAt: now, attempts: job.attempts + 1 })
      .where(and(eq(schema.jobRuns.id, job.id), eq(schema.jobRuns.status, "queued")))) as unknown as [
      { affectedRows?: number },
    ];
    if (!claim?.affectedRows) continue;

    const handler = handlers.get(job.type);
    if (!handler) {
      await db
        .update(schema.jobRuns)
        .set({ status: "failed", error: `No handler for ${job.type}` })
        .where(eq(schema.jobRuns.id, job.id));
      return true;
    }
    const claimed: ClaimedJob = {
      id: job.id,
      workspaceId: job.workspaceId,
      type: job.type,
      payload: job.payload,
      attempts: job.attempts + 1,
    };
    try {
      const result = await handler(job.payload, claimed);
      await db
        .update(schema.jobRuns)
        .set({ status: "completed", result: (result ?? null) as never, error: null })
        .where(eq(schema.jobRuns.id, job.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : "job failed";
      const attempts = job.attempts + 1;
      const willRetry = attempts < MAX_ATTEMPTS;
      await db
        .update(schema.jobRuns)
        .set({
          status: willRetry ? "queued" : "failed",
          error: message,
          runAfter: willRetry ? new Date(now.getTime() + attempts * 15_000) : job.runAfter,
          claimedAt: null,
        })
        .where(eq(schema.jobRuns.id, job.id));
    }
    return true;
  }
  return false;
}

let timer: NodeJS.Timeout | null = null;
let tickIntervalMs = 3000;
let lastTickAt: Date | null = null;

/**
 * What the worker can say about itself. `lastTickAt` is the only proof that the
 * interval is actually firing: a process that is up, healthy and wedged inside
 * one long handler looks identical from the outside to one that is working.
 */
export function workerStatus(): { running: boolean; lastTickAt: Date | null; intervalMs: number } {
  return { running: timer !== null, lastTickAt, intervalMs: tickIntervalMs };
}

export function registeredJobTypes(): string[] {
  return [...handlers.keys()];
}

// ── Queue monitoring ─────────────────────────────────────────────────────────
// A queue that quietly stops moving is the worst failure mode this system has:
// nothing errors, the site looks alive, and no follow-up ever reaches a prospect.
// Every number below exists to make one specific silent failure loud.

/** Aggregate facts, straight from the database. No interpretation here. */
export interface QueueFacts {
  queuedByType: { type: string; count: number; oldestDueAt: Date | null }[];
  running: number;
  /** `running` rows still unclaimed past the reclaim window — the worker died mid-job. */
  stuckRunning: number;
  failedLastDay: number;
}

export interface QueueReport extends QueueFacts {
  totalQueued: number;
  /** Queued types this process has no handler for: they would wait forever. */
  unhandled: { type: string; count: number }[];
  oldestWaitingMinutes: number | null;
  workerRunning: boolean;
  lastTickMinutesAgo: number | null;
  /** Waiting work held by the master switch: expected, so not a fault. */
  heldMinutes: number | null;
  stalled: boolean;
  health: "ok" | "degraded";
  problems: string[];
}

const minutesBetween = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / 60_000);

/** Backlog beyond which waiting is worth a human's attention, in minutes. */
const BACKLOG_MINUTES = 15;

/**
 * How long a running worker may stay silent before we call it wedged: five ticks,
 * rounded up to at least a minute so a fast interval never flags on rounding.
 * One definition, used both by the queue report and by the health endpoint.
 */
export function heartbeatGraceMinutes(intervalMs: number): number {
  return Math.max(1, Math.ceil((intervalMs * 5) / 60_000));
}

/**
 * The interpretation of queue facts, kept pure so that "stalled" and "degraded"
 * are testable claims rather than a reading-comprehension exercise over SQL.
 */
export function summarizeQueue(
  facts: QueueFacts,
  opts: {
    handlers: string[];
    now: Date;
    workerRunning: boolean;
    lastTickAt: Date | null;
    intervalMs: number;
    autonomyPaused: boolean;
  },
): QueueReport {
  const known = new Set(opts.handlers);
  const unhandled = facts.queuedByType.filter((q) => !known.has(q.type));
  const runnable = facts.queuedByType.filter((q) => known.has(q.type));
  const totalQueued = facts.queuedByType.reduce((n, q) => n + q.count, 0);
  const runnableQueued = runnable.reduce((n, q) => n + q.count, 0);

  const dueDates = runnable.map((q) => q.oldestDueAt).filter((d): d is Date => d !== null);
  const oldestDueAt = dueDates.length ? new Date(Math.min(...dueDates.map((d) => d.getTime()))) : null;
  const oldestWaitingMinutes = oldestDueAt ? Math.max(0, minutesBetween(opts.now, oldestDueAt)) : null;

  const lastTickMinutesAgo = opts.lastTickAt ? minutesBetween(opts.now, opts.lastTickAt) : null;
  // Two different ways to lose the worker. Not started at all is only a problem
  // when there is work to do; started-but-not-ticking means the loop is wedged
  // (or the process is blocked), which is a problem even when the queue is empty
  // because it will not recover on its own.
  const graceMinutes = heartbeatGraceMinutes(opts.intervalMs);
  const heartbeatStale =
    opts.workerRunning && (lastTickMinutesAgo === null || lastTickMinutesAgo > graceMinutes);
  const noWorker = !opts.workerRunning && runnableQueued > 0;
  const stalled = heartbeatStale || noWorker;

  const problems: string[] = [];
  if (unhandled.length > 0) {
    const list = unhandled.map((u) => `${u.type} (${u.count})`).join(", ");
    problems.push(`Queued jobs have no handler in this process and will wait forever: ${list}.`);
  }
  if (stalled) {
    problems.push(
      heartbeatStale
        ? `The job worker is running but has not ticked since ${lastTickMinutesAgo ?? "startup"} min ago — the loop is wedged or the process is blocked.`
        : `The job worker is not running while ${runnableQueued} job(s) are waiting.`,
    );
  }
  if (facts.stuckRunning > 0) {
    problems.push(
      `${facts.stuckRunning} job(s) still marked running past the ${Math.round(RECLAIM_WINDOW_MS / 60_000)}-minute reclaim window.`,
    );
  }
  // A backlog while autonomy is paused is the switch working, not the system
  // failing, so it is reported as held work instead of a problem — with one
  // exception above: a worker that is not running would still not drain it.
  if (oldestWaitingMinutes !== null && oldestWaitingMinutes > BACKLOG_MINUTES && !opts.autonomyPaused) {
    problems.push(`Backlog: the oldest runnable job has waited ${oldestWaitingMinutes} minutes.`);
  }
  if (facts.failedLastDay > 0) {
    problems.push(`${facts.failedLastDay} job(s) failed in the last 24 hours.`);
  }

  return {
    ...facts,
    totalQueued,
    unhandled,
    oldestWaitingMinutes,
    workerRunning: opts.workerRunning,
    lastTickMinutesAgo,
    heldMinutes: opts.autonomyPaused ? oldestWaitingMinutes : null,
    stalled,
    health: problems.length > 0 ? "degraded" : "ok",
    problems,
  };
}

/**
 * Live queue health. Returns null when there is no database — which is itself the
 * answer the caller must report, never silently rendered as "all clear".
 */
export async function queueReport(): Promise<QueueReport | null> {
  const db = getDb();
  if (!db) return null;
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const reclaimBefore = new Date(now.getTime() - RECLAIM_WINDOW_MS);

  const [queuedRows, runningRows, stuckRows, failedRows] = await Promise.all([
    db
      .select({ type: schema.jobRuns.type, count: count(), oldestDueAt: min(schema.jobRuns.runAfter) })
      .from(schema.jobRuns)
      .where(eq(schema.jobRuns.status, "queued"))
      .groupBy(schema.jobRuns.type),
    db.select({ n: count() }).from(schema.jobRuns).where(eq(schema.jobRuns.status, "running")),
    db
      .select({ n: count() })
      .from(schema.jobRuns)
      .where(and(eq(schema.jobRuns.status, "running"), lt(schema.jobRuns.claimedAt, reclaimBefore))),
    db
      .select({ n: count() })
      .from(schema.jobRuns)
      .where(and(eq(schema.jobRuns.status, "failed"), gte(schema.jobRuns.updatedAt, dayAgo))),
  ]);

  const facts: QueueFacts = {
    queuedByType: queuedRows.map((r) => ({
      type: r.type,
      count: Number(r.count),
      oldestDueAt: r.oldestDueAt instanceof Date ? r.oldestDueAt : null,
    })),
    running: Number(runningRows[0]?.n ?? 0),
    stuckRunning: Number(stuckRows[0]?.n ?? 0),
    failedLastDay: Number(failedRows[0]?.n ?? 0),
  };
  const worker = workerStatus();
  return summarizeQueue(facts, {
    handlers: registeredJobTypes(),
    now,
    workerRunning: worker.running,
    lastTickAt: worker.lastTickAt,
    intervalMs: worker.intervalMs,
    autonomyPaused: await isAutopilotGloballyPaused(),
  });
}

/**
 * What the process can say about its own worker without asking the database —
 * cheap enough for an external monitor to poll every few seconds. `wedged` is the
 * one failure a restart fixes and that no other probe can see: the HTTP server
 * keeps answering while the queue stops moving.
 */
export function workerHealth(now = new Date()): {
  running: boolean;
  lastTickMinutesAgo: number | null;
  intervalMs: number;
  graceMinutes: number;
  wedged: boolean;
} {
  const { running, lastTickAt, intervalMs } = workerStatus();
  const lastTickMinutesAgo = lastTickAt ? minutesBetween(now, lastTickAt) : null;
  const graceMinutes = heartbeatGraceMinutes(intervalMs);
  return {
    running,
    lastTickMinutesAgo,
    intervalMs,
    graceMinutes,
    wedged: running && (lastTickMinutesAgo === null || lastTickMinutesAgo > graceMinutes),
  };
}

// Alerting, for a deployment that has no alerting service: the worker judges
// itself on a slow timer and writes what it found into the process log, which
// every hosting provider already ships and can watch for a string. Five minutes
// is often enough to notice a stopped queue and never enough to matter to a
// single job, and it costs four indexed COUNT queries.
const WATCHDOG_INTERVAL_MS = 5 * 60_000;
let lastWatchdogAt = 0;
let watchdogInFlight: Promise<void> | null = null;

async function runWatchdog(now: Date): Promise<void> {
  if (now.getTime() - lastWatchdogAt < WATCHDOG_INTERVAL_MS) return;
  lastWatchdogAt = now.getTime();
  const report = await queueReport();
  for (const problem of report?.problems ?? []) {
    console.warn(`[jobs] queue degraded: ${problem}`);
  }
}

export function startJobWorker(intervalMs = 3000): () => void {
  if (timer) return () => stopJobWorker();
  tickIntervalMs = intervalMs;
  // Count the start itself as a tick: a probe that arrived in the first second
  // would otherwise read "running, never ticked" and call a healthy worker wedged.
  lastTickAt = new Date();
  const tick = async () => {
    try {
      lastTickAt = new Date();
      let processed = true;
      let guard = 0;
      while (processed && guard++ < 10) {
        processed = await runNextJob();
      }
      if (!watchdogInFlight) {
        watchdogInFlight = runWatchdog(new Date()).finally(() => {
          watchdogInFlight = null;
        });
      }
    } catch (err) {
      console.error("[jobs] worker tick failed:", err);
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => stopJobWorker();
}

export function stopJobWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
