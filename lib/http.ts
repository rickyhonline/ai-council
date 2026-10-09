import { NextResponse } from "next/server";
import { ZodError } from "zod";

// Verify the host as well as origin to prevent DNS rebinding against the local runtime.
export function localRequest(request: Request) {
  const isLocal = (hostname: string) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (
    !isLocal(url.hostname) ||
    (host && !isLocal(new URL(`http://${host}`).hostname))
  )
    throw new Error("Use the app's localhost address.");
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin)
    throw new Error("Cross-origin requests are not allowed.");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new Error("Cross-site requests are not allowed.");
}
// Bound bytes as they arrive, before allocating or parsing the complete request.
export async function localBody(request: Request): Promise<unknown> {
  localRequest(request);
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new Error("Send application/json.");
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 256000) {
          await reader.cancel();
          throw new Error("Request is too large.");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  return JSON.parse(text);
}
export function failure(error: unknown) {
  if (error instanceof ZodError || error instanceof SyntaxError)
    return NextResponse.json(
      {
        error:
          "Invalid request or local data format. Check the supplied fields.",
      },
      { status: 400 },
    );
  if ((error as NodeJS.ErrnoException).code === "ENOENT")
    return NextResponse.json(
      { error: "This council session no longer exists." },
      { status: 404 },
    );
  const message =
    error instanceof Error &&
    [
      "Cross-origin requests are not allowed.",
      "Cross-site requests are not allowed.",
      "Send application/json.",
      "Request is too large.",
      "Use the app's localhost address.",
    ].includes(error.message)
      ? error.message
      : "Unable to read or save local council files. Check the local data folder permissions.";
  return NextResponse.json({ error: message }, { status: 400 });
}
