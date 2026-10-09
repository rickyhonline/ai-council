import type { Message } from "./types";

// A cancelled/failed turn may leave trailing user messages. Replay the complete
// latest saved reply block, including its facilitator, rather than mixing advisors.
export function latestCouncilContributions(messages: Message[]): Message[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1].speaker.toLowerCase() === "user") end--;
  let start = end;
  while (start > 0 && messages[start - 1].speaker.toLowerCase() !== "user")
    start--;
  return messages.slice(start, end);
}
