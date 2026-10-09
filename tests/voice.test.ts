import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { GET, POST } from "../app/api/voice/route";
import { POST as edit } from "../app/api/session/route";
import { advisors, createSession, saveSession } from "../lib/storage";
import {
  dialogueAudio,
  stockVoices,
  voiceAssignments,
  VoiceError,
} from "../lib/voice";

async function isolated(t: TestContext, configured = false) {
  const previousDirectory = process.env.COUNCIL_DATA_DIR;
  const previousKey = process.env.ELEVENLABS_API_KEY;
  const directory = await mkdtemp(path.join(tmpdir(), "council-voice-"));
  process.env.COUNCIL_DATA_DIR = directory;
  if (configured)
    process.env.ELEVENLABS_API_KEY = `test-only-${crypto.randomUUID()}`;
  else delete process.env.ELEVENLABS_API_KEY;
  t.after(async () => {
    if (previousDirectory === undefined) delete process.env.COUNCIL_DATA_DIR;
    else process.env.COUNCIL_DATA_DIR = previousDirectory;
    if (previousKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  });
}
function request(route: string, body: unknown) {
  return new Request(`http://127.0.0.1:3210/api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function socketServer(t: TestContext) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const openSocket = (_url: string, options: WebSocket.ClientOptions) =>
    new WebSocket(`ws://127.0.0.1:${address.port}`, options);
  return { server, openSocket };
}

test("missing ElevenLabs key is explicit; only persisted council replies can be spoken", async (t) => {
  await isolated(t);
  const descriptor = await GET(new Request("http://127.0.0.1:3210/api/voice"));
  assert.equal(descriptor.status, 200);
  const config = await descriptor.json();
  assert.equal(config.configured, false);
  assert.equal(config.model, "eleven_v4_turbo");
  assert.match(config.error, /ELEVENLABS_API_KEY/);
  assert.deepEqual(config.voices, []);
  const session = await createSession();
  const userId = crypto.randomUUID();
  const replyId = crypto.randomUUID();
  session.messages.push(
    {
      id: userId,
      speaker: "user",
      text: "Private input",
      createdAt: new Date().toISOString(),
    },
    {
      id: replyId,
      speaker: "alex",
      text: "Run a short test.",
      createdAt: new Date().toISOString(),
    },
  );
  await saveSession(session);
  assert.equal(
    (await POST(request("voice", { sessionId: session.id, messageId: userId })))
      .status,
    400,
  );
  const missing = await POST(
    request("voice", {
      sessionId: session.id,
      messageId: replyId,
      text: "This arbitrary text must never be sent",
    }),
  );
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /ELEVENLABS_API_KEY/);
});

test("stock discovery paginates, excludes clones, and persists only eligible advisor assignments", async (t) => {
  await isolated(t, true);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    calls++;
    assert.equal(url.searchParams.get("category"), "premade");
    assert.equal(url.searchParams.get("voice_type"), "default");
    assert.equal(
      new Headers(options.headers).get("xi-api-key"),
      process.env.ELEVENLABS_API_KEY,
    );
    return Response.json(
      calls === 1
        ? {
            voices: [
              { voice_id: "B", name: "B stock", category: "premade" },
              { voice_id: "A", name: "A stock", category: "premade" },
              { voice_id: "X", name: "A personal clone", category: "cloned" },
            ],
            has_more: true,
            next_page_token: "next",
          }
        : {
            voices: ["C", "D", "E"].map((id) => ({
              voice_id: id,
              name: `${id} stock`,
              category: "premade",
            })),
            has_more: false,
            next_page_token: null,
          },
    );
  });
  const voices = await stockVoices();
  assert.deepEqual(
    voices.map((v) => v.id),
    ["A", "B", "C", "D", "E"],
  );
  assert.equal(calls, 2);
  assert.deepEqual(voiceAssignments(await advisors(), voices), {
    elon: "A",
    jeff: "B",
    alex: "C",
    albert: "D",
    facilitator: "E",
  });
  assert.equal(
    (
      await edit(
        request("session", {
          action: "elevenVoice",
          advisorId: "alex",
          voiceId: "X",
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await edit(
        request("session", {
          action: "elevenVoice",
          advisorId: "alex",
          voiceId: "E",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await advisors()).find((member) => member.id === "alex")?.elevenVoiceId,
    "E",
  );
  const descriptor = await GET(new Request("http://127.0.0.1:3210/api/voice"));
  assert.equal((await descriptor.json()).assignments.alex, "E");
  assert.equal(
    calls,
    2,
    "cached discovery prevents repeated voice-list requests",
  );
  assert.equal(
    (
      await edit(
        request("session", {
          action: "elevenVoice",
          advisorId: "alex",
          voiceId: "",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await advisors()).find((member) => member.id === "alex")?.elevenVoiceId,
    undefined,
  );
  assert.equal(voiceAssignments(await advisors(), voices).alex, "C");
});

test("dialogue socket follows verified one-voice frames and joins audio until is_final", async (t) => {
  await isolated(t, true);
  const { server, openSocket } = await socketServer(t);
  const frames: unknown[] = [];
  server.on("connection", (socket, incoming) => {
    assert.equal(
      incoming.headers["xi-api-key"],
      process.env.ELEVENLABS_API_KEY,
    );
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      frames.push(message);
      if (message.close_socket) {
        socket.send(
          JSON.stringify({
            audio: Buffer.from("first-").toString("base64"),
            is_final: false,
          }),
        );
        socket.send(
          JSON.stringify({
            audio: Buffer.from("second").toString("base64"),
            is_final: true,
          }),
        );
      }
    });
  });
  const audio = await dialogueAudio(
    "A saved council reply.",
    "stock-a",
    undefined,
    (url, options) => {
      assert.match(url, /model_id=eleven_v4_turbo&output_format=mp3_44100_128/);
      return openSocket(url, options);
    },
  );
  assert.equal(audio.toString(), "first-second");
  assert.deepEqual(frames, [
    { voices: ["stock-a"] },
    {
      inputs: [
        {
          text: "A saved council reply.",
          voice_id: "stock-a",
          new_turn: false,
        },
      ],
    },
    { close_socket: true },
  ]);
});

test("stop cancels the outgoing socket, while oversized or unfinished audio fails safely", async (t) => {
  await isolated(t, true);
  const { server, openSocket } = await socketServer(t);
  let mode: "cancel" | "oversized" | "unfinished" = "cancel";
  let cancelReady: () => void;
  const ready = new Promise<void>((resolve) => {
    cancelReady = resolve;
  });
  let cancelClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    cancelClosed = resolve;
  });
  server.on("connection", (socket) => {
    const current = mode;
    if (current === "cancel") socket.on("close", () => cancelClosed());
    socket.on("message", (data) => {
      if (!JSON.parse(data.toString()).close_socket) return;
      if (current === "cancel") cancelReady();
      else if (current === "unfinished") socket.close();
      else {
        const audio = Buffer.alloc(6 * 1024 * 1024).toString("base64");
        socket.send(JSON.stringify({ audio, is_final: false }));
        socket.send(JSON.stringify({ audio, is_final: true }));
      }
    });
  });
  const controller = new AbortController();
  const pending = dialogueAudio(
    "Read this reply.",
    "stock-a",
    controller.signal,
    openSocket,
  );
  const rejected = assert.rejects(
    pending,
    (error: unknown) => error instanceof VoiceError && error.status === 499,
  );
  await ready;
  controller.abort();
  await rejected;
  await closed;
  mode = "oversized";
  await assert.rejects(
    dialogueAudio("Read this reply.", "stock-a", undefined, openSocket),
    /size limit/,
  );
  mode = "unfinished";
  await assert.rejects(
    dialogueAudio("Read this reply.", "stock-a", undefined, openSocket),
    /closed before the audio finished/,
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    dialogueAudio("Read this reply.", "stock-a", aborted.signal, () => {
      assert.fail("a pre-aborted turn must not open a socket");
    }),
    /stopped/,
  );
});
