import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { computerQueue, releaseStuckLine } from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
afterEach(() => f?.close());

const MIN = 60_000;

test("a run past the time limit leaves the line with its own reason; an away computer's runs stop holding it up", async () => {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" };
  const { machineId } = await pairMachine(deps, f.owner.id, f.org.id, {
    name: "Studio",
    hostname: "studio",
    os: "linux",
    arch: "x64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/home/a/agentes",
    exec: true,
  });
  const now = Date.now();
  const online = async (on: boolean) =>
    f.db
      .update(schema.machines)
      .set({ online: on, lastSeenAt: new Date(now) })
      .where(eq(schema.machines.id, machineId));
  const waiting = async (since: number, room?: string) => {
    const [m] = await f.db
      .insert(schema.messages)
      .values({ orgId: f.org.id, channelId: f.general.id, authorType: "person", authorUserId: f.owner.id, body: "hi" })
      .returning();
    const [r] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: (m as { id: string }).id,
        triggerMessageId: (m as { id: string }).id,
        trigger: "mention",
        hop: 1,
        status: "waiting_input",
        brain: "claude_code",
        waitingMachineId: machineId,
        transcript: {
          waitingForBrain: { code: "busy", machineId, waitId: crypto.randomUUID(), ...(room ? { room } : {}) },
          roomWaitSince: since,
        },
      })
      .returning();
    return (r as { id: string }).id;
  };
  const state = async (id: string) => {
    const [r] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id));
    return r as typeof schema.agentRuns.$inferSelect;
  };

  // Online: only the run past the limit goes, stopped with the reason; the other keeps its place.
  await online(true);
  const old = await waiting(now - 40 * MIN, "line");
  const fresh = await waiting(now - 5 * MIN, "spacing");
  const q = await computerQueue(f.db, f.owner.id, f.org.id, machineId, now);
  expect(q.waiting.find((w) => w.runId === fresh)).toMatchObject({ waitedMs: 5 * MIN, cause: "spacing" });
  const out = await releaseStuckLine({ db: f.db }, { maxWaitMs: 30 * MIN, now });
  expect(out).toEqual({ offline: [], timedOut: [old] });
  expect(await state(old)).toMatchObject({ status: "canceled", error: "room_wait_timeout" });
  expect((await state(fresh)).status).toBe("waiting_input");

  // 0 turns the limit off.
  const older = await waiting(now - 90 * MIN);
  expect(await releaseStuckLine({ db: f.db }, { maxWaitMs: 0, now })).toEqual({ offline: [], timedOut: [] });
  expect((await state(older)).status).toBe("waiting_input");

  // The computer is away: the waits become outage waits (out of the line), and the line says why while they lasted.
  await online(false);
  const away = await computerQueue(f.db, f.owner.id, f.org.id, machineId, now);
  expect(away.waiting.every((w) => w.cause === "machine_offline")).toBe(true);
  const gone = await releaseStuckLine({ db: f.db }, { maxWaitMs: 0, now });
  expect(gone.offline.sort()).toEqual([fresh, older].sort());
  expect((await state(fresh)).transcript).toMatchObject({ waitingForBrain: { code: "machine_offline" } });
  expect((await computerQueue(f.db, f.owner.id, f.org.id, machineId, now)).waiting).toHaveLength(0);
});
