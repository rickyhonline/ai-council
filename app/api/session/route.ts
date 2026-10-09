import { NextResponse } from "next/server";
import { z } from "zod";
import {
  boardSchema,
  createSession,
  readSession,
  saveSession,
  saveAdvisorVoice,
  saveAdvisorElevenVoice,
  transaction,
} from "@/lib/storage";
import { failure, localBody } from "@/lib/http";
import { stockVoices, VoiceError } from "@/lib/voice";
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }),
  z.object({
    action: z.literal("voice"),
    advisorId: z.enum(["elon", "jeff", "alex", "albert"]),
    voiceURI: z.string().max(500),
  }),
  z.object({
    action: z.literal("elevenVoice"),
    advisorId: z.enum(["elon", "jeff", "alex", "albert"]),
    voiceId: z.string().max(100),
  }),
  z.object({
    action: z.literal("board"),
    sessionId: z.uuid(),
    board: boardSchema,
  }),
]);
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = input.parse(await localBody(request));
    if (body.action === "elevenVoice" && body.voiceId) {
      const voices = await stockVoices(request.signal);
      if (!voices.some((voice) => voice.id === body.voiceId))
        throw new VoiceError(
          "Choose an available stock ElevenLabs voice.",
          400,
        );
    }
    return await transaction(async () => {
      if (body.action === "create")
        return NextResponse.json(await createSession());
      if (body.action === "voice")
        return NextResponse.json({
          advisors: await saveAdvisorVoice(body.advisorId, body.voiceURI),
        });
      if (body.action === "elevenVoice")
        return NextResponse.json({
          advisors: await saveAdvisorElevenVoice(body.advisorId, body.voiceId),
        });
      const session = await readSession(body.sessionId);
      session.board = body.board;
      if (body.board.problem) session.title = body.board.problem.slice(0, 120);
      return NextResponse.json(await saveSession(session));
    });
  } catch (error) {
    if (error instanceof VoiceError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    return failure(error);
  }
}
