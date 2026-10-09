import { NextResponse } from "next/server";
import { z } from "zod";
import { advisors, readSession } from "@/lib/storage";
import { failure, localBody, localRequest } from "@/lib/http";
import {
  dialogueAudio,
  stockVoices,
  voiceAssignments,
  voiceConfigurationError,
  voiceModel,
  VoiceError,
} from "@/lib/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.object({ sessionId: z.uuid(), messageId: z.uuid() });

export async function GET(request: Request) {
  try {
    localRequest(request);
    const missing = voiceConfigurationError();
    if (missing)
      return NextResponse.json(
        {
          configured: false,
          error: missing,
          model: voiceModel,
          voices: [],
          assignments: {},
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    try {
      const voices = await stockVoices(request.signal);
      return NextResponse.json(
        {
          configured: true,
          model: voiceModel,
          voices,
          assignments: voiceAssignments(await advisors(), voices),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      if (!(error instanceof VoiceError)) throw error;
      return NextResponse.json(
        {
          configured: false,
          error: error.message,
          model: voiceModel,
          voices: [],
          assignments: {},
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = input.parse(await localBody(request));
    const session = await readSession(body.sessionId);
    const message = session.messages.find((m) => m.id === body.messageId);
    if (
      !message ||
      !["elon", "jeff", "alex", "albert", "facilitator"].includes(
        message.speaker,
      )
    )
      throw new VoiceError("Choose a saved council reply to read aloud.", 400);
    z.string().trim().min(1).max(8000).parse(message.text);
    const voices = await stockVoices(request.signal);
    const assignments = voiceAssignments(await advisors(), voices);
    const audio = await dialogueAudio(
      message.text,
      assignments[message.speaker],
      request.signal,
    );
    return new Response(new Uint8Array(audio), {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
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
