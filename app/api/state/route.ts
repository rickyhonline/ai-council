import { NextResponse } from "next/server";
import {
  advisors,
  createSession,
  dataDirectory,
  sessions,
  transaction,
} from "@/lib/storage";
import { failure, localRequest } from "@/lib/http";
import { configuredModel, configurationError } from "@/lib/council";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    localRequest(request);
    return await transaction(async () => {
      let saved = await sessions();
      if (!saved.length) saved = [await createSession()];
      return NextResponse.json(
        {
          sessions: saved,
          advisors: await advisors(),
          configured: !configurationError(),
          configurationError: configurationError(),
          model: configuredModel(),
          dataPath: dataDirectory(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    });
  } catch (error) {
    return failure(error);
  }
}
