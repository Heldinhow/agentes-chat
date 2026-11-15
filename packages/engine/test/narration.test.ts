import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { drainOutbox, listMessages, postPersonMessage, type ToolSource } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

/** A built-in-like tool every agent may call (no scope), counting its calls. */
function envTool() {
  let calls = 0;
  const source: ToolSource = {
    name: "env",
    tools: async () => [
      {
        name: "check_env",
        description: "Check the environment",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          calls++;
          return { content: calls === 1 ? "go: not found" : "gcc: not found" };
        },
      },
    ],
  };
  return { source, calls: () => calls };
}

const turns = (req: ModelRequest) => req.messages.filter((m) => m.role === "assistant").length;

/** An answer past `WORKING_TEXT_MAX`: read as the answer before its turn ends. */
const LONG = "Não dá para compilar aqui: faltam Go e gcc no computador. ".repeat(6);

test("a 3-call tool loop: only the first line before tools goes live, once; the rest goes to the steps; the answer shows whole", async () => {
  const env = envTool();
  f = await setup({
    toolSources: [env.source],
    reply: (req) => {
      const n = turns(req);
      if (n === 0)
        return { chunks: ["Começo verificando ", "o ambiente."], toolUses: [{ name: "check_env", input: {} }] };
      if (n === 1)
        return {
          chunks: ["Go não está instalado. ", "Vou tentar o compilador C."],
          toolUses: [{ name: "check_env", input: {} }],
        };
      return { chunks: [LONG, "Instale os dois."] };
    },
  });
  const events = f.listen(f.general.id);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev compila o projeto",
  });
  await drainOutbox(f.db, f.handlers);
  expect(env.calls()).toBe(2);

  // Its first line before tools is posted as it starts, the final answer whole after it.
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.map((m) => m.body)).toEqual([
    "@dev compila o projeto",
    "Começo verificando o ambiente",
    `${LONG}Instale os dois.`.trim(),
  ]);

  // Nothing else of the working text reached the conversation live, on any event but each call's step line (`said`,
  // ADR 0121): the first sentence written before it.
  const said = events.flatMap((e) => ("said" in e && e.said ? [e.said] : []));
  expect(said).toEqual(["Começo verificando o ambiente", "Go não está instalado"]);
  const live = JSON.stringify(events, (k, v) => (k === "said" ? undefined : v));
  expect(live).not.toContain("Vou tentar o compilador");
  expect(live).not.toContain("Go não está instalado");
  expect(live.split("Começo verificando").length - 1).toBe(1);

  // The answer too: only its message carries it; the last call said it writes.
  const before = JSON.stringify(events.filter((e) => e.type !== "message.created"));
  expect(before).not.toContain("Instale os dois");
  expect(events.some((e) => e.type === "agent.typing")).toBe(true);

  // Steps: the model calls keep the narration, for the run's activity.
  const [run] = await f.db.select().from(schema.agentRuns);
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
  const calls = steps
    .filter((s) => s.kind === "model_call")
    .sort((a, b) => a.seq - b.seq)
    .map((s) => (s.data as { narration?: string }).narration ?? null);
  expect(calls).toEqual(["Começo verificando o ambiente.", "Go não está instalado. Vou tentar o compilador C.", null]);
});

test("a short answer shows whole in its message, with no tool call to wait for", async () => {
  f = await setup({ reply: () => ({ chunks: ["Tudo ", "certo."] }) });
  const events = f.listen(f.general.id);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, f.handlers);
  const reply = events.find(
    (e) =>
      e.type === "message.created" &&
      (e as { message?: { author: { type: string } } }).message?.author.type === "agent",
  );
  expect(reply).toMatchObject({ message: { body: "Tudo certo." } });
  expect(JSON.stringify(events.filter((e) => e !== reply))).not.toContain("certo");
});

test("a final call with no text adds nothing to the first line it said live, and the run is done", async () => {
  const env = envTool();
  f = await setup({
    toolSources: [env.source],
    reply: (req) =>
      turns(req) === 0
        ? { chunks: ["Instalando e testando."], toolUses: [{ name: "check_env", input: {} }] }
        : { chunks: [] },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev prepara o ambiente",
  });
  await drainOutbox(f.db, f.handlers);
  const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(timeline.map((m) => m.body)).toEqual(["@dev prepara o ambiente", "Instalando e testando"]);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
});
