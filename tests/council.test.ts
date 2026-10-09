import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MockLanguageModelV4 } from "ai/test";
import {
  createSession,
  saveSession,
  readSession,
  transaction,
} from "../lib/storage";
import { discuss, mergeBoard } from "../lib/council";
import {
  modelChoices,
  configuredModel,
  councilModel,
  configurationError,
} from "../lib/models";
import { prepareContext, recentStart } from "../lib/context";

function modelWith(outputs: string[]) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: outputs.shift()! }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}
test("facilitator may invite nobody, and selection receives real participation history", async () => {
  process.env.COUNCIL_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "council-routing-"),
  );
  const session = await createSession();
  session.messages.push({
    id: crypto.randomUUID(),
    speaker: "elon",
    text: "A prior contribution",
    createdAt: new Date().toISOString(),
  });
  const model = modelWith([
    JSON.stringify({
      invite: [],
      reason: "No new decision to explore.",
      reply: "You are welcome.",
    }),
  ]);
  const result = await discuss(session, "Thanks!", undefined, model);
  assert.deepEqual(result.selection.invited, []);
  assert.equal(result.contributions.length, 1);
  assert.equal(result.selection.participation.elon, 1);
  assert.match(
    JSON.stringify(model.doGenerateCalls[0].prompt),
    /Participation counts/,
  );
  assert.match(
    JSON.stringify(model.doGenerateCalls[0].prompt),
    /Avoid monopolizing/,
  );
});
test("explicit advisor takes priority and synthesis preserves user-owned decisions", async () => {
  process.env.COUNCIL_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "council-explicit-"),
  );
  const session = await createSession();
  session.board.decisions = ["Keep the budget at $100"];
  const model = modelWith([
    "Run one bounded experiment.",
    JSON.stringify({
      text: "Try it and measure the result.",
      additions: {
        ideas: ["Experiment"],
        questions: [],
        options: ["One-week test"],
        tradeoffs: ["Speed vs certainty"],
      },
    }),
  ]);
  const result = await discuss(session, "What next?", "alex", model);
  assert.deepEqual(result.selection.invited, ["alex"]);
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(result.selection.participation.alex, 1);
  assert.deepEqual(
    result.contributions.map((m) => m.speaker),
    ["alex", "facilitator"],
  );
  assert.deepEqual(mergeBoard(session.board, result.additions).decisions, [
    "Keep the budget at $100",
  ]);
});
test("blank advisor output fails the turn instead of saving an empty contribution", async (t) => {
  const previousDirectory = process.env.COUNCIL_DATA_DIR;
  const directory = await mkdtemp(path.join(tmpdir(), "council-empty-"));
  process.env.COUNCIL_DATA_DIR = directory;
  t.after(async () => {
    if (previousDirectory === undefined) delete process.env.COUNCIL_DATA_DIR;
    else process.env.COUNCIL_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  });
  const session = await createSession();
  const model = modelWith(["   "]);
  await assert.rejects(
    discuss(session, "What next?", "alex", model),
    /advisor returned no useful reply/,
  );
  assert.equal(model.doGenerateCalls.length, 1);
});

test("direct provider credentials configure choices without Gateway and take priority", (t) => {
  const names = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AI_GATEWAY_API_KEY",
    "COUNCIL_MODEL",
  ];
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  t.after(() =>
    names.forEach((name) => {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }),
  );
  names.forEach((name) => {
    delete process.env[name];
  });
  process.env.ANTHROPIC_API_KEY = "test-credential-never-used-on-network";
  assert.equal(configuredModel(), "anthropic/claude-sonnet-5-5");
  assert.deepEqual(
    modelChoices().map((x) => x.configured),
    [false, true, true],
  );
  assert.equal(configurationError(), undefined);
  assert.match(configurationError("openai/gpt-5.4-mini")!, /OPENAI_API_KEY/);
  assert.equal(councilModel().provider, "anthropic.messages");
  process.env.COUNCIL_MODEL = "anthropic/claude-haiku-5-5";
  assert.equal(configuredModel(), "anthropic/claude-haiku-5-5");
  process.env.OPENAI_API_KEY = "test-credential-never-used-on-network";
  process.env.AI_GATEWAY_API_KEY = "optional-test-key";
  assert.equal(
    councilModel("openai/gpt-5.4-mini").provider,
    "openai.responses",
  );
});

test("older history compacts durably, retrieves original IDs and resumes without losing transcript", async (t) => {
  const before = process.env.COUNCIL_DATA_DIR;
  const directory = await mkdtemp(path.join(tmpdir(), "council-memory-"));
  process.env.COUNCIL_DATA_DIR = directory;
  t.after(async () => {
    if (before === undefined) delete process.env.COUNCIL_DATA_DIR;
    else process.env.COUNCIL_DATA_DIR = before;
    await rm(directory, { recursive: true, force: true });
  });
  const session = await createSession();
  session.messages = Array.from({ length: 45 }, (_, i) => ({
    id: crypto.randomUUID(),
    speaker: i % 2 ? "alex" : "user",
    text:
      i === 0
        ? "The saffron project requires a $125 budget; do not replace it."
        : `Earlier discussion ${i}`,
    createdAt: new Date().toISOString(),
  }));
  await saveSession(session);
  const checkpoints: string[] = [];
  const model = modelWith([
    "Remember saffron: budget $125.",
    "Keep saffron budget $125; later discussion remains open.",
  ]);
  const prepared = await prepareContext(
    session,
    "What was the saffron budget?",
    model,
    undefined,
    async (memory) => {
      await transaction(async () => {
        const latest = await readSession(session.id);
        latest.memory = memory;
        await saveSession(latest);
      });
      checkpoints.push(memory.throughMessageId);
    },
  );
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(checkpoints.at(-1), session.messages[24].id);
  const context = JSON.parse(prepared.context);
  assert.equal(context.conversation.length, 20);
  assert.equal(context.retrievedEarlierMessages[0].id, session.messages[0].id);
  assert.match(context.retrievedEarlierMessages[0].text, /\$125/);
  const restored = await readSession(session.id);
  assert.deepEqual(restored.messages, session.messages);
  assert.equal(restored.memory?.throughMessageId, session.messages[24].id);
  const noExtraCalls = modelWith([]);
  await prepareContext(restored, "saffron", noExtraCalls);
  assert.equal(noExtraCalls.doGenerateCalls.length, 0);
  assert.equal(recentStart(session.messages), 25);
});

test("interruption after an advisor reply prevents the synthesis stage", async () => {
  const session = await createSession();
  const controller = new AbortController();
  const model = modelWith(["A useful contribution."]);
  const original = model.doGenerate;
  model.doGenerate = async (options) => {
    const result = await original(options);
    controller.abort();
    return result;
  };
  await assert.rejects(
    discuss(session, "What next?", "alex", model, {
      abortSignal: controller.signal,
    }),
    /abort/i,
  );
  assert.equal(model.doGenerateCalls.length, 1);
});
