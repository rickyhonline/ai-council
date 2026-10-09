import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { gateway } from "ai";
import { z } from "zod";

// IDs verified against the providers' current model documentation.
export const modelIdSchema = z.enum([
  "openai/gpt-5.4-mini",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
]);
export type ModelId = z.infer<typeof modelIdSchema>;
const available = [
  { id: "openai/gpt-5.4-mini", provider: "openai", name: "GPT-5.4 mini" },
  {
    id: "anthropic/claude-sonnet-5-5",
    provider: "anthropic",
    name: "Claude Sonnet 5.5",
  },
  {
    id: "anthropic/claude-haiku-5-5",
    provider: "anthropic",
    name: "Claude Haiku 5.5",
  },
] as const;
const directKey = (provider: string) =>
  provider === "openai"
    ? process.env.OPENAI_API_KEY
    : process.env.ANTHROPIC_API_KEY;
export function modelChoices() {
  return available.map((entry) => ({
    ...entry,
    configured: Boolean(
      directKey(entry.provider) || process.env.AI_GATEWAY_API_KEY,
    ),
  }));
}
export function configuredModel(): ModelId {
  const preferred = modelIdSchema.safeParse(process.env.COUNCIL_MODEL);
  const choices = modelChoices();
  if (
    preferred.success &&
    choices.some((x) => x.id === preferred.data && x.configured)
  )
    return preferred.data;
  return choices.find((x) => x.configured)?.id ?? available[0].id;
}
export function configurationError(id: ModelId = configuredModel()) {
  const provider = id.split("/")[0];
  if (directKey(provider) || process.env.AI_GATEWAY_API_KEY) return undefined;
  return `Set ${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} in .env.local and restart the app. An optional AI_GATEWAY_API_KEY also supports this provider.`;
}
export function councilModel(id: ModelId = configuredModel()) {
  const [provider, model] = id.split("/");
  if (directKey(provider)) {
    return provider === "openai"
      ? createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).responses(model)
      : createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(model);
  }
  if (process.env.AI_GATEWAY_API_KEY) return gateway(id);
  throw new Error(configurationError(id));
}
// Council owns its context locally; Responses need not retain a server conversation.
export const councilProviderOptions = {
  openai: { store: false, reasoningEffort: "low" },
  // The provider maps disabled to between_tools for Sonnet 5.5; Haiku accepts disabled.
  anthropic: { thinking: { type: "disabled" }, effort: "medium" },
};
