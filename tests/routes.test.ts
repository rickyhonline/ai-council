import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { POST as turn } from "../app/api/council/route";
import { POST as edit } from "../app/api/session/route";
import { GET as state } from "../app/api/state/route";
import {
  acquireTurn,
  releaseTurn,
  createSession,
  readSession,
  advisors,
} from "../lib/storage";
import { localBody } from "../lib/http";

async function isolatedStore(t: TestContext) {
  const previousDirectory = process.env.COUNCIL_DATA_DIR;
  const previousKey = process.env.AI_GATEWAY_API_KEY;
  const directory = await mkdtemp(path.join(tmpdir(), "council-routes-"));
  process.env.COUNCIL_DATA_DIR = directory;
  delete process.env.AI_GATEWAY_API_KEY;
  t.after(async () => {
    if (previousDirectory === undefined) delete process.env.COUNCIL_DATA_DIR;
    else process.env.COUNCIL_DATA_DIR = previousDirectory;
    if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
function request(
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`http://127.0.0.1:3210/api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("unconfigured turns save input once, release locks, and retain edited decisions and voice configuration", async (t) => {
  const directory = await isolatedStore(t);
  const session = await createSession();
  const body = { sessionId: session.id, text: "Choose a small experiment." };
  const failed = await turn(request("council", body));
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error, /message was saved locally/);
  assert.equal((await turn(request("council", body))).status, 503);
  const saved = await readSession(session.id);
  assert.equal(saved.messages.length, 1);
  assert.equal(saved.messages[0].text, body.text);
  saved.board.decisions = ["Limit the first trial to $100"];
  saved.board.ideas = ["A user-edited idea"];
  assert.equal(
    (
      await edit(
        request("session", {
          action: "board",
          sessionId: session.id,
          board: saved.board,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await edit(
        request("session", {
          action: "voice",
          advisorId: "alex",
          voiceURI: "Stock voice A",
        }),
      )
    ).status,
    200,
  );
  assert.equal((await turn(request("council", body))).status, 503);
  const snapshot = await state(new Request("http://127.0.0.1:3210/api/state"));
  assert.equal(snapshot.status, 200);
  const restored = await snapshot.json();
  assert.equal(restored.configured, false);
  assert.equal(restored.sessions[0].messages.length, 1);
  assert.deepEqual(restored.sessions[0].board, saved.board);
  assert.equal(
    (await advisors()).find((member) => member.id === "alex")?.voiceURI,
    "Stock voice A",
  );
  assert.match(
    await readFile(
      path.join(directory, "sessions", `${session.id}.md`),
      "utf8",
    ),
    /Limit the first trial to \$100/,
  );
});

test("a competing turn is rejected without releasing the owner's lock or saving a competing user message", async (t) => {
  await isolatedStore(t);
  const session = await createSession();
  assert.equal(acquireTurn(session.id), true);
  try {
    const response = await turn(
      request("council", { sessionId: session.id, text: "Competing turn" }),
    );
    assert.equal(response.status, 409);
    assert.equal(acquireTurn(session.id), false);
    assert.equal((await readSession(session.id)).messages.length, 0);
  } finally {
    releaseTurn(session.id);
  }
  assert.equal(
    (
      await turn(
        request("council", { sessionId: session.id, text: "Owner finished" }),
      )
    ).status,
    503,
  );
});

test("local routes reject foreign hosts/origins and bound streamed request bytes", async (t) => {
  await isolatedStore(t);
  assert.equal(
    (await state(new Request("http://attacker.example/api/state"))).status,
    400,
  );
  assert.equal(
    (
      await state(
        new Request("http://127.0.0.1:3210/api/state", {
          headers: { host: "attacker.example:3210" },
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await edit(
        request(
          "session",
          { action: "create" },
          {
            origin: "https://attacker.example",
          },
        ),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await state(
        new Request("http://127.0.0.1:3210/api/state", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
      )
    ).status,
    400,
  );
  await assert.rejects(
    localBody(request("session", { text: "é".repeat(130000) })),
    /Request is too large/,
  );
});
