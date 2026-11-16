import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  consultationConversation,
  consultationsIn,
  createAgent,
  drainOutbox,
  insertMessage,
  openPersonAgentDm,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function nino() {
  return createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Nino", handle: "nino", role: "Faturamento", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
}

async function devRunFor(userId: string, body: string): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

const ask = (ctx: ToolContext) => {
  if (!f.tools) throw new Error("no tools");
  return f.tools.invoke(ctx, {
    toolUseId: `tu_${crypto.randomUUID()}`,
    name: "ask_agent",
    input: { agent: "@nino", question: "A fatura 812 foi paga?" },
  });
};

describe("the person's DM with the consulted agent", () => {
  test("shows the question asked for them from another conversation, live, and opens it", async () => {
    f = await setup({ askAgent: true, reply: () => ({ chunks: ["Paga em 3/11."] }) });
    const consulted = await nino();
    const lia = await addMember(f.db, f.org.id, "member", "lia");
    const mine = await openPersonAgentDm(f.db, f.org.id, f.owner.id, consulted.id);
    const hers = await openPersonAgentDm(f.db, f.org.id, lia.id, consulted.id);
    const heard = f.listen(mine.id);
    const elsewhere = f.listen(hers.id);

    await ask(await devRunFor(f.owner.id, "@dev a fatura 812 foi paga?"));
    const [row] = await f.db.select().from(schema.agentConsultations);
    expect(heard.some((e) => e.type === "agent.consultation" && e.consultationId === row?.id)).toBe(true);

    const [listed] = await consultationsIn(f.db, f.org.id, mine.id);
    expect(listed).toMatchObject({
      id: row?.id,
      fromElsewhere: true,
      agentId: f.agent.id,
      consultedAgentId: consulted.id,
    });
    expect(await consultationsIn(f.db, f.org.id, hers.id)).toEqual([]);
    const [asked] = await consultationsIn(f.db, f.org.id, f.general.id);
    expect(asked?.id).toBe(row?.id);
    expect(asked?.fromElsewhere).toBeUndefined();

    const opened = await consultationConversation(f.db, f.org.id, mine.id, row?.id ?? "");
    expect(opened?.consultation).toMatchObject({ id: row?.id, fromElsewhere: true });
    expect(opened?.messages[0]?.body).toBe("A fatura 812 foi paga?");
    expect(await consultationConversation(f.db, f.org.id, hers.id, row?.id ?? "")).toBeNull();

    const before = heard.length;
    await drainOutbox(f.db, f.handlers);
    expect(heard.slice(before).some((e) => e.type === "agent.consultation" && e.consultationId === row?.id)).toBe(true);
    expect((await consultationsIn(f.db, f.org.id, mine.id))[0]).toMatchObject({
      status: "answered",
      fromElsewhere: true,
    });
    expect(elsewhere.some((e) => e.type === "agent.consultation")).toBe(false);
  });

  test("no DM with the consulted agent: none is opened for it", async () => {
    f = await setup({ askAgent: true, reply: () => ({ chunks: ["Paga."] }) });
    await nino();
    const dms = () => f.db.select().from(schema.channels).where(eq(schema.channels.kind, "dm"));
    const before = (await dms()).length;
    await ask(await devRunFor(f.owner.id, "@dev a fatura 812 foi paga?"));
    await drainOutbox(f.db, f.handlers);
    const [row] = await f.db.select().from(schema.agentConsultations);
    expect((await dms()).filter((c) => c.id !== row?.channelId)).toHaveLength(before);
  });
});
