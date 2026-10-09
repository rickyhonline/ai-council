import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSession,
  readSession,
  saveSession,
  sessions,
  advisors,
  knowledgeFor,
  transaction,
} from "../lib/storage";

test("durable local snapshots, transcript export, bounded knowledge and serialized updates", async () => {
  process.env.COUNCIL_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "council-test-"),
  );
  const session = await createSession();
  session.board.problem = "Choose a reversible product experiment";
  session.board.decisions = ["Run a one-week trial"];
  session.messages.push({
    id: crypto.randomUUID(),
    speaker: "user",
    text: "Keep the initial budget small.",
    createdAt: new Date().toISOString(),
  });
  await saveSession(session);
  assert.deepEqual((await readSession(session.id)).board, session.board);
  assert.equal((await sessions()).length, 1);
  assert.match(
    await readFile(
      path.join(process.env.COUNCIL_DATA_DIR, "sessions", session.id + ".md"),
      "utf8",
    ),
    /Run a one-week trial/,
  );
  assert.equal((await advisors()).length, 4);
  await assert.rejects(() => readSession("../private"));
  const folder = path.join(process.env.COUNCIL_DATA_DIR, "knowledge", "elon");
  await writeFile(
    path.join(folder, "experiment.md"),
    "Source: local user notes\nTest each experiment with a reversible trial.",
  );
  await symlink(
    path.join(process.env.COUNCIL_DATA_DIR, "sessions", session.id + ".json"),
    path.join(folder, "private.md"),
  );
  assert.match(
    await knowledgeFor("elon", "experiment"),
    /SOURCE FILE: experiment.md/,
  );
  assert.doesNotMatch(await knowledgeFor("elon", "budget"), /private.md/);
  await Promise.all(
    [1, 2].map((n) =>
      transaction(async () => {
        const value = await readSession(session.id);
        value.board.ideas.push(String(n));
        await saveSession(value);
      }),
    ),
  );
  assert.deepEqual((await readSession(session.id)).board.ideas, ["1", "2"]);
});
