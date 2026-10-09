import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  lstat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { starterAdvisors } from "./advisors";
import type { Board, Session } from "./types";
import { modelIdSchema } from "./models";

export const boardSchema = z.object({
  problem: z.string().max(8000),
  ideas: z.array(z.string().max(4000)).max(50),
  questions: z.array(z.string().max(4000)).max(50),
  options: z.array(z.string().max(4000)).max(50),
  tradeoffs: z.array(z.string().max(4000)).max(50),
  decisions: z.array(z.string().max(4000)).max(50),
});
const advisorSchema = z.object({
  id: z.enum(["elon", "jeff", "alex", "albert"]),
  name: z.string().max(100),
  role: z.string().max(100),
  color: z.string().regex(/^#[a-f\d]{6}$/i),
  initials: z.string().max(4),
  instructions: z.string().max(8000),
  voiceURI: z.string().max(500).optional(),
  elevenVoiceId: z.string().max(100).optional(),
});
const sessionSchema = z.object({
  id: z.uuid(),
  title: z.string().max(120),
  messages: z.array(
    z.object({
      id: z.uuid(),
      speaker: z.string().max(100),
      text: z.string().max(16000),
      createdAt: z.iso.datetime(),
    }),
  ),
  board: boardSchema,
  updatedAt: z.iso.datetime(),
  modelId: modelIdSchema.optional(),
  memory: z
    .object({
      summary: z.string().trim().min(1).max(10000),
      throughMessageId: z.uuid(),
      updatedAt: z.iso.datetime(),
    })
    .optional(),
  lastTurn: z
    .object({
      invited: z.array(z.string()).max(2),
      reason: z.string().max(1000),
      participation: z.record(z.string(), z.number().int().nonnegative()),
      modelId: modelIdSchema.optional(),
    })
    .optional(),
});
const emptyBoard = (): Board => ({
  problem: "",
  ideas: [],
  questions: [],
  options: [],
  tradeoffs: [],
  decisions: [],
});
export const dataDirectory = () =>
  path.resolve(
    process.env.COUNCIL_DATA_DIR || path.join(process.cwd(), ".council"),
  );
const sessionFile = (id: string) =>
  path.join(dataDirectory(), "sessions", `${z.uuid().parse(id)}.json`);

// One local Node process owns writes. The JSON snapshot is canonical; Markdown is an export.
// Next route bundles and development reloads share the same process-wide owner.
const processState = globalThis as typeof globalThis & {
  aiCouncilLocalState?: { pending: Promise<unknown>; active: Set<string> };
};
const localState = (processState.aiCouncilLocalState ??= {
  pending: Promise.resolve(),
  active: new Set<string>(),
});
export async function transaction<T>(work: () => Promise<T>): Promise<T> {
  const next = localState.pending.then(work, work);
  localState.pending = next.catch(() => {});
  return next;
}
export function acquireTurn(id: string) {
  if (localState.active.has(id)) return false;
  localState.active.add(id);
  return true;
}
export function releaseTurn(id: string) {
  localState.active.delete(id);
}
async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function initializeStore() {
  const directory = dataDirectory();
  await mkdir(path.join(directory, "sessions"), {
    recursive: true,
    mode: 0o700,
  });
  try {
    await readFile(path.join(directory, "advisors.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicJson(path.join(directory, "advisors.json"), starterAdvisors);
  }
  for (const advisor of starterAdvisors) {
    await mkdir(path.join(directory, "knowledge", advisor.id), {
      recursive: true,
      mode: 0o700,
    });
  }
}
export async function advisors() {
  await initializeStore();
  return z
    .array(advisorSchema)
    .length(4)
    .refine(
      (items) => new Set(items.map((x) => x.id)).size === 4,
      "Advisor IDs must be unique",
    )
    .parse(
      JSON.parse(
        await readFile(path.join(dataDirectory(), "advisors.json"), "utf8"),
      ),
    );
}
export async function saveAdvisorVoice(advisorId: string, voiceURI: string) {
  const members = await advisors();
  const id = z.enum(["elon", "jeff", "alex", "albert"]).parse(advisorId);
  const updated = members.map((member) =>
    member.id === id
      ? { ...member, voiceURI: z.string().max(500).parse(voiceURI) }
      : member,
  );
  await atomicJson(path.join(dataDirectory(), "advisors.json"), updated);
  return updated;
}
export async function saveAdvisorElevenVoice(
  advisorId: string,
  elevenVoiceId: string,
) {
  const members = await advisors();
  const id = z.enum(["elon", "jeff", "alex", "albert"]).parse(advisorId);
  const updated = members.map((member) =>
    member.id === id
      ? {
          ...member,
          elevenVoiceId: z.string().max(100).parse(elevenVoiceId) || undefined,
        }
      : member,
  );
  await atomicJson(path.join(dataDirectory(), "advisors.json"), updated);
  return updated;
}
export async function sessions() {
  await initializeStore();
  const files = await readdir(path.join(dataDirectory(), "sessions"));
  const values = await Promise.all(
    files
      .filter((name) => /^[a-f\d-]{36}\.json$/i.test(name))
      .map(async (name) =>
        sessionSchema.parse(
          JSON.parse(
            await readFile(
              path.join(dataDirectory(), "sessions", name),
              "utf8",
            ),
          ),
        ),
      ),
  );
  return values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function readSession(id: string): Promise<Session> {
  return sessionSchema.parse(
    JSON.parse(await readFile(sessionFile(id), "utf8")),
  );
}
export async function saveSession(session: Session): Promise<Session> {
  const checked = sessionSchema.parse(session);
  checked.updatedAt = new Date().toISOString();
  await atomicJson(sessionFile(checked.id), checked);
  const markdown =
    `# ${checked.title}\n\n` +
    Object.entries(checked.board)
      .map(
        ([key, value]) =>
          `## ${key}\n\n${typeof value === "string" ? value : value.map((x) => `- ${x}`).join("\n")}\n`,
      )
      .join("\n") +
    "\n## Conversation\n\n" +
    checked.messages
      .map((m) => `### ${m.speaker} · ${m.createdAt}\n\n${m.text}\n`)
      .join("\n");
  // This derived file never determines whether the canonical conversation was saved.
  await writeFile(sessionFile(checked.id).replace(/\.json$/, ".md"), markdown, {
    mode: 0o600,
  }).catch(() => {});
  return checked;
}
export async function createSession(): Promise<Session> {
  await initializeStore();
  return saveSession({
    id: randomUUID(),
    title: "New council",
    messages: [],
    board: emptyBoard(),
    updatedAt: new Date().toISOString(),
  });
}

// Local curated files only: no symlinks, no network fetch, bounded context with filename attribution.
export async function knowledgeFor(
  advisorId: string,
  query: string,
): Promise<string> {
  const id = z.enum(["elon", "jeff", "alex", "albert"]).parse(advisorId);
  const directory = path.join(dataDirectory(), "knowledge", id);
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((x) => x.length > 3)
    .slice(0, 24);
  const names = (await readdir(directory))
    .filter((x) => /\.(md|txt)$/i.test(x))
    .sort()
    .slice(0, 30);
  const candidates = await Promise.all(
    names.map(async (name) => {
      const file = path.join(directory, name);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64000)
        return null;
      const content = await readFile(file, "utf8");
      const score = terms.reduce(
        (sum, term) => sum + Number(content.toLowerCase().includes(term)),
        0,
      );
      return { name, content, score };
    }),
  );
  return candidates
    .filter((x): x is NonNullable<typeof x> => !!x && x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => `SOURCE FILE: ${x.name}\n${x.content.slice(0, 4000)}`)
    .join("\n\n")
    .slice(0, 10000);
}
