import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MockLanguageModelV4 } from "ai/test";
import { createSession } from "../lib/storage";
import { discuss, mergeBoard } from "../lib/council";

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
