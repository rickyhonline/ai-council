import WebSocket from "ws";
import { z } from "zod";
import type { Advisor } from "./types";

export const voiceModel = "eleven_v4_turbo";
export const voiceConfigurationError = () =>
  process.env.ELEVENLABS_API_KEY
    ? undefined
    : "Set ELEVENLABS_API_KEY in .env.local and restart the app to enable ElevenLabs voices. Browser voices remain available.";

export class VoiceError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}
export type StockVoice = { id: string; name: string };
const voiceListSchema = z.object({
  voices: z
    .array(
      z.object({
        voice_id: z.string().min(1).max(100),
        name: z.string().max(200),
        category: z.string(),
      }),
    )
    .max(200),
  has_more: z.boolean(),
  next_page_token: z.string().nullable().optional(),
});
let cached: { key: string; expires: number; voices: StockVoice[] } | undefined;

// Only stock default/premade voices are eligible; personal clones never enter the selector.
export async function stockVoices(signal?: AbortSignal): Promise<StockVoice[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new VoiceError(voiceConfigurationError()!, 503);
  if (signal?.aborted)
    throw new VoiceError("Speech generation was stopped.", 499);
  if (cached?.key === key && cached.expires > Date.now()) return cached.voices;
  const voices: StockVoice[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const url = new URL("https://api.elevenlabs.io/v2/voices");
    url.searchParams.set("category", "premade");
    url.searchParams.set("voice_type", "default");
    url.searchParams.set("page_size", "100");
    url.searchParams.set("include_total_count", "false");
    if (token) url.searchParams.set("next_page_token", token);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "xi-api-key": key },
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(signal ? [signal] : []),
        ]),
        cache: "no-store",
      });
    } catch {
      if (signal?.aborted)
        throw new VoiceError("Speech generation was stopped.", 499);
      throw new VoiceError(
        "Unable to load ElevenLabs stock voices. Check your connection and try again.",
      );
    }
    if (!response.ok)
      throw new VoiceError(
        "Unable to load ElevenLabs stock voices. Check the server-only key and its Voices permission.",
      );
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new VoiceError(
        "ElevenLabs returned an unexpected voice list. Try again later.",
      );
    }
    const parsed = voiceListSchema.safeParse(payload);
    if (!parsed.success)
      throw new VoiceError(
        "ElevenLabs returned an unexpected voice list. Try again later.",
      );
    voices.push(
      ...parsed.data.voices
        .filter((v) => v.category === "premade")
        .map((v) => ({ id: v.voice_id, name: v.name })),
    );
    if (!parsed.data.has_more) break;
    token = parsed.data.next_page_token ?? undefined;
    if (!token)
      throw new VoiceError(
        "ElevenLabs returned an incomplete voice list. Try again later.",
      );
  }
  const sorted = [...new Map(voices.map((v) => [v.id, v])).values()].sort(
    (a, b) => a.id.localeCompare(b.id),
  );
  if (!sorted.length)
    throw new VoiceError(
      "No stock ElevenLabs voices are accessible with this key. Check its Voices permission.",
      503,
    );
  cached = { key, expires: Date.now() + 5 * 60 * 1000, voices: sorted };
  return sorted;
}

export function voiceAssignments(
  members: Advisor[],
  voices: StockVoice[],
): Record<string, string> {
  if (!voices.length) return {};
  const ids = new Set(voices.map((v) => v.id));
  const order = ["elon", "jeff", "alex", "albert"];
  return Object.fromEntries([
    ...members.map((member) => [
      member.id,
      member.elevenVoiceId && ids.has(member.elevenVoiceId)
        ? member.elevenVoiceId
        : voices[Math.max(0, order.indexOf(member.id)) % voices.length].id,
    ]),
    ["facilitator", voices[4 % voices.length].id],
  ]);
}

// The documented Text-to-Dialogue protocol supports one registered voice per v4 Turbo socket.
// https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd
export async function dialogueAudio(
  text: string,
  voiceId: string,
  signal?: AbortSignal,
  openSocket: (url: string, options: WebSocket.ClientOptions) => WebSocket = (
    url,
    options,
  ) => new WebSocket(url, options),
): Promise<Buffer> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new VoiceError(voiceConfigurationError()!, 503);
  const checked = z.string().trim().min(1).max(8000).parse(text);
  z.string().min(1).max(100).parse(voiceId);
  if (signal?.aborted)
    throw new VoiceError("Speech generation was stopped.", 499);
  const maxBytes = 10 * 1024 * 1024;
  const url = `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=${voiceModel}&output_format=mp3_44100_128`;
  return new Promise<Buffer>((resolve, reject) => {
    const socket = openSocket(url, {
      headers: { "xi-api-key": key },
      maxPayload: Math.ceil((maxBytes * 4) / 3) + 1024,
      handshakeTimeout: 15000,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: VoiceError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        socket.terminate();
        reject(error);
      } else {
        socket.close();
        resolve(Buffer.concat(chunks, size));
      }
    };
    const abort = () =>
      finish(new VoiceError("Speech generation was stopped.", 499));
    const timer = setTimeout(
      () =>
        finish(
          new VoiceError(
            "ElevenLabs speech took too long. Try replaying a shorter response.",
            504,
          ),
        ),
      45000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("open", () => {
      if (settled) return;
      socket.send(JSON.stringify({ voices: [voiceId] }));
      socket.send(
        JSON.stringify({
          inputs: [{ text: checked, voice_id: voiceId, new_turn: false }],
        }),
      );
      socket.send(JSON.stringify({ close_socket: true }));
    });
    socket.on("message", (data) => {
      if (settled) return;
      try {
        const message = JSON.parse(data.toString());
        if (message.error)
          throw new VoiceError(
            "ElevenLabs could not generate this speech. Check the key, credits, and v4 Turbo model access.",
          );
        if (message.audio) {
          if (
            typeof message.audio !== "string" ||
            message.audio.length > Math.ceil(((maxBytes - size) * 4) / 3) + 4
          )
            throw new VoiceError(
              "The generated audio exceeded the local size limit.",
              413,
            );
          const chunk = Buffer.from(message.audio, "base64");
          size += chunk.length;
          if (size > maxBytes)
            throw new VoiceError(
              "The generated audio exceeded the local size limit.",
              413,
            );
          chunks.push(chunk);
        }
        if (message.is_final === true) {
          if (!size)
            throw new VoiceError(
              "ElevenLabs returned no audio. Try replaying the response.",
            );
          finish();
        }
      } catch (error) {
        finish(
          error instanceof VoiceError
            ? error
            : new VoiceError(
                "ElevenLabs returned an unexpected audio response. Try again.",
              ),
        );
      }
    });
    socket.on("error", () =>
      finish(
        new VoiceError(
          "Unable to generate ElevenLabs speech. Check the server-only key, connection, credits, and v4 Turbo model access.",
        ),
      ),
    );
    socket.on("close", () => {
      if (!settled)
        finish(
          new VoiceError(
            "ElevenLabs closed before the audio finished. Try replaying the response.",
          ),
        );
    });
  });
}
