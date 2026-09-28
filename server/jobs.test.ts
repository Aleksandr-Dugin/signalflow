// Unit tests for queue monitoring (server/services/jobs.ts).
//
// `summarizeQueue` is pure on purpose: the SQL in queueReport() only counts rows,
// so every judgement a human relies on — "stalled", "degraded", "this waiting is
// expected" — is decided here and is therefore testable without a database. Each
// case below corresponds to one silent failure the function exists to make loud.
import { describe, expect, it } from "vitest";
import { heartbeatGraceMinutes, summarizeQueue, workerHealth, type QueueFacts } from "./services/jobs";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const facts = (over: Partial<QueueFacts> = {}): QueueFacts => ({
  queuedByType: [],
  running: 0,
  stuckRunning: 0,
  failedLastDay: 0,
  ...over,
});

const summary = (f: QueueFacts, over = {}) =>
  summarizeQueue(f, {
    handlers: ["reply.followup", "campaign.discovery"],
    now: NOW,
    workerRunning: true,
    lastTickAt: minsAgo(0),
    intervalMs: 30_000,
    autonomyPaused: false,
    ...over,
  });

describe("heartbeatGraceMinutes", () => {
  it("never rounds a fast interval down to zero minutes", () => {
    expect(heartbeatGraceMinutes(3_000)).toBe(1);
    expect(heartbeatGraceMinutes(15_000)).toBe(2);
    expect(heartbeatGraceMinutes(60_000)).toBe(5);
  });
});

describe("summarizeQueue", () => {
  it("reports a healthy idle queue as healthy", () => {
    const r = summary(facts());
    expect(r.health).toBe("ok");
    expect(r.problems).toEqual([]);
    expect(r.stalled).toBe(false);
    expect(r.oldestWaitingMinutes).toBeNull();
  });

  it("names queued types this process cannot run, because they would wait forever", () => {
    const r = summary(
      facts({ queuedByType: [{ type: "legacy.digest", count: 4, oldestDueAt: minsAgo(3) }] }),
    );
    expect(r.unhandled).toMatchObject([{ type: "legacy.digest", count: 4 }]);
    expect(r.totalQueued).toBe(4);
    expect(r.health).toBe("degraded");
    expect(r.problems.join(" ")).toContain("legacy.digest (4)");
    expect(r.problems.join(" ")).toMatch(/no handler|will wait forever/);
    // The same work must not also be counted as a backlog: it is not slow, it is
    // impossible, and the operator needs the second diagnosis, not the first.
    expect(r.problems.join(" ")).not.toMatch(/Backlog/);
    expect(r.oldestWaitingMinutes).toBeNull();
  });

  it("flags a missing worker only when there is runnable work to do", () => {
    const withWork = summary(facts({ queuedByType: [{ type: "reply.followup", count: 2, oldestDueAt: minsAgo(1) }] }), {
      workerRunning: false,
      lastTickAt: null,
    });
    expect(withWork.stalled).toBe(true);
    expect(withWork.problems.join(" ")).toContain("2 job(s) are waiting");

    // Nothing queued and no worker: not a fault to raise, and in dev it is the
    // normal state. The UI still shows "worker not running", so this is a
    // withheld alarm, never a claim that the worker is alive.
    const idle = summary(facts(), { workerRunning: false, lastTickAt: null });
    expect(idle.stalled).toBe(false);
    expect(idle.workerRunning).toBe(false);
  });

  it("still reports a missing worker while autonomy is paused", () => {
    // Pausing holds jobs on purpose — but a paused platform with no worker would
    // also fail to drain them on resume, and that is worth hearing now.
    const r = summary(
      facts({ queuedByType: [{ type: "reply.followup", count: 3, oldestDueAt: minsAgo(1) }] }),
      { workerRunning: false, lastTickAt: null, autonomyPaused: true },
    );
    expect(r.stalled).toBe(true);
    expect(r.problems.join(" ")).toMatch(/not running/);
    expect(r.heldMinutes).not.toBeNull();
  });

  it("calls a started worker that stopped ticking wedged", () => {
    const r = summary(facts(), { lastTickAt: minsAgo(10) });
    expect(r.stalled).toBe(true);
    expect(r.health).toBe("degraded");
    expect(r.problems.join(" ")).toMatch(/wedged or the process is blocked/);
  });

  it("does not call a worker wedged while it is busy inside a long job", () => {
    // The heartbeat is written at the start of every tick, so this covers a
    // discovery run that takes minutes: interval callbacks keep firing.
    const r = summary(facts(), { lastTickAt: minsAgo(1) });
    expect(r.stalled).toBe(false);
  });

  it("treats a running worker with no tick recorded as wedged", () => {
    const r = summary(facts(), { lastTickAt: null });
    expect(r.stalled).toBe(true);
  });

  it("surfaces jobs left running past the reclaim window", () => {
    const r = summary(facts({ stuckRunning: 2 }));
    expect(r.health).toBe("degraded");
    expect(r.problems.join(" ")).toContain("2 job(s) still marked running past the 10-minute reclaim window");
  });

  it("reports a runnable backlog beyond the threshold", () => {
    const r = summary(
      facts({ queuedByType: [{ type: "campaign.discovery", count: 6, oldestDueAt: minsAgo(20) }] }),
    );
    expect(r.oldestWaitingMinutes).toBe(20);
    expect(r.problems.join(" ")).toMatch(/oldest runnable job has waited 20 minutes/);
  });

  it("leaves a short wait unremarked", () => {
    const r = summary(
      facts({ queuedByType: [{ type: "campaign.discovery", count: 1, oldestDueAt: minsAgo(4) }] }),
    );
    expect(r.oldestWaitingMinutes).toBe(4);
    expect(r.problems).toEqual([]);
  });

  it("calls work held by the master switch held, not broken", () => {
    const r = summary(
      facts({ queuedByType: [{ type: "reply.followup", count: 9, oldestDueAt: minsAgo(40) }] }),
      { autonomyPaused: true },
    );
    expect(r.health).toBe("ok");
    expect(r.problems).toEqual([]);
    expect(r.heldMinutes).toBe(40);
  });

  it("counts failures in the last day as a problem", () => {
    const r = summary(facts({ failedLastDay: 3 }));
    expect(r.health).toBe("degraded");
    expect(r.problems.join(" ")).toContain("3 job(s) failed in the last 24 hours");
  });

  it("queues nothing but a due date in the future as zero waiting", () => {
    const r = summary(
      facts({ queuedByType: [{ type: "reply.followup", count: 1, oldestDueAt: new Date(NOW.getTime() + 5 * 60_000) }] }),
    );
    expect(r.oldestWaitingMinutes).toBe(0);
    expect(r.problems).toEqual([]);
  });

  it("keeps raw counts visible next to the verdict", () => {
    const input = facts({
      queuedByType: [{ type: "reply.followup", count: 2, oldestDueAt: minsAgo(1) }],
      running: 1,
      stuckRunning: 0,
      failedLastDay: 0,
    });
    expect(summary(input)).toMatchObject({ ...input, totalQueued: 2 });
  });
});

describe("workerHealth", () => {
  it("is not wedged before the worker has ever started", () => {
    // A server with no database never starts its worker. That must stay a 200: the
    // process is healthy, and 503 belongs to a worker that started and froze.
    const h = workerHealth(NOW);
    expect(h.running).toBe(false);
    expect(h.wedged).toBe(false);
    expect(h.lastTickMinutesAgo).toBeNull();
    // The module default is the 3 s the server starts with: five ticks would be
    // 15 s, and the floor of one minute keeps rounding from raising a false alarm.
    expect(h.intervalMs).toBe(3_000);
    expect(h.graceMinutes).toBe(1);
  });
});
