import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { localBody, failure } from "@/lib/http";
import {
  acquireTurn,
  releaseTurn,
  readSession,
  saveSession,
  transaction,
} from "@/lib/storage";
import { configurationError, discuss, mergeBoard } from "@/lib/council";
export const runtime = "nodejs";
const input = z.object({
  sessionId: z.uuid(),
  text: z.string().trim().min(1).max(8000),
  advisorId: z.enum(["elon", "jeff", "alex", "albert"]).optional(),
});
export async function POST(request: Request) {
  let sessionId: string | undefined;
  let acquired = false;
  try {
    const body = input.parse(await localBody(request));
    sessionId = body.sessionId;
    if (!acquireTurn(sessionId))
      return NextResponse.json(
        {
          error:
            "This council is already considering a turn. Wait for it to finish before sending another.",
        },
        { status: 409 },
      );
    acquired = true;
    const session = await transaction(async () => {
      const saved = await readSession(body.sessionId);
      // A failed turn keeps the draft. Retrying that draft reuses its saved user message.
      const last = saved.messages.at(-1);
      if (last?.speaker !== "user" || last.text !== body.text)
        saved.messages.push({
          id: randomUUID(),
          speaker: "user",
          text: body.text,
          createdAt: new Date().toISOString(),
        });
      if (saved.title === "New council") saved.title = body.text.slice(0, 120);
      if (!saved.board.problem) saved.board.problem = body.text;
      return saveSession(saved);
    });
    const missing = configurationError();
    if (missing)
      return NextResponse.json(
        {
          error: `${missing} Your message was saved locally; your draft is kept for retry.`,
        },
        { status: 503 },
      );
    let result: Awaited<ReturnType<typeof discuss>>;
    try {
      result = await discuss(session, body.text, body.advisorId);
    } catch {
      return NextResponse.json(
        {
          error:
            "The model call did not finish. Check the server-only key, model ID, gateway credits or connection. Your message is saved and your draft is kept for retry.",
        },
        { status: 502 },
      );
    }
    return await transaction(async () => {
      const latest = await readSession(body.sessionId);
      latest.messages.push(
        ...result.contributions.map((m) => ({
          ...m,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
        })),
      );
      latest.board = mergeBoard(latest.board, result.additions);
      latest.lastTurn = result.selection;
      return NextResponse.json(await saveSession(latest));
    });
  } catch (error) {
    return failure(error);
  } finally {
    if (acquired && sessionId) releaseTurn(sessionId);
  }
}
