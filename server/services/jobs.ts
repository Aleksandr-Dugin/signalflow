import { and, asc, eq, inArray, lt } from "drizzle-orm";
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
        lt(schema.jobRuns.claimedAt, new Date(now.getTime() - 10 * 60 * 1000)),
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

export function startJobWorker(intervalMs = 3000): () => void {
  if (timer) return () => stopJobWorker();
  const tick = async () => {
    try {
      let processed = true;
      let guard = 0;
      while (processed && guard++ < 10) {
        processed = await runNextJob();
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
