import { test } from "node:test";
import assert from "node:assert/strict";
import { latestCouncilContributions } from "../lib/playback";
import type { Message } from "../lib/types";
const message = (speaker: string, text: string): Message => ({
  id: crypto.randomUUID(),
  speaker,
  text,
  createdAt: new Date().toISOString(),
});
test("replay after cancelled turns preserves the latest complete reply and facilitator", () => {
  const latest = [
    message("albert", "Latest advisor"),
    message("facilitator", "Latest synthesis"),
  ];
  const transcript = [
    message("user", "Earlier question"),
    message("elon", "Old reply"),
    message("user", "Latest question"),
    ...latest,
  ];
  assert.deepEqual(latestCouncilContributions(transcript), latest);
  assert.deepEqual(
    latestCouncilContributions([
      ...transcript,
      message("user", "Cancelled"),
      message("user", "Failed retry"),
    ]),
    latest,
  );
  const facilitator = message("facilitator", "No advisor needed");
  assert.deepEqual(
    latestCouncilContributions([
      ...transcript,
      message("user", "Thanks"),
      facilitator,
      message("user", "Cancelled"),
    ]),
    [facilitator],
  );
  assert.deepEqual(
    latestCouncilContributions([message("user", "No saved reply")]),
    [],
  );
});
