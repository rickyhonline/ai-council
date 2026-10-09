# AI Council

A local meeting room for exploring decisions with AI interpretations inspired by Elon Musk, Jeff Bezos, Alex Hormozi, and Albert Einstein. These are generated starter perspectives, not the actual people or endorsements. Researching their source collections is deferred.

**Current state:** the visual room, selectable advisors, editable whiteboard, durable sessions, AI SDK council workflow and ordered browser speech are implemented. The current reasoning scaffold uses AI Gateway, but the final agent runtime/provider is awaiting architecture review. It is not a requirement of the room or voice layer. Without one, the app saves your input and explains the missing configuration; it never supplies canned advisor responses.

## Run locally

Requires Node.js 22+.

```sh
npm ci
npm run dev
```

Copy `.env.example` to `.env.local` and set `AI_GATEWAY_API_KEY` to enable council reasoning. Never paste keys into chat or commit them. The optional `AI_GATEWAY_MODEL` selects a gateway model; the initial default is `openai/gpt-5.4-mini`, verified in the live catalog during setup.

Open http://localhost:3210. The server binds only to the local computer. Use `npm run build` and `npm start` for a local production build. `npm test` checks durable file snapshots and bounded knowledge; `npm run typecheck` validates TypeScript.

## Your files

The first load creates `.council/`, ignored by Git:

```text
.council/
  advisors.json                 # Editable starter configuration
  sessions/<uuid>.json          # Canonical conversation and whiteboard
  sessions/<uuid>.md            # Derived readable export
  knowledge/elon/*.md
  knowledge/jeff/*.md
  knowledge/alex/*.md
  knowledge/albert/*.md
```

Optionally set `COUNCIL_DATA_DIR` in `.env.local` to an absolute directory outside this checkout. Keep data and secrets outside published source. JSON writes use atomic rename and serialize updates within one local Node process. Run one app instance per data directory. Back up this folder like any other personal documents. Markdown exports are derived; JSON remains canonical.

Knowledge files may contain notes and source URLs with dates and attribution. Retrieval selects up to three matching `.md`/`.txt` files per advisor, excludes symlinks and files over 64 KB, and caps returned context. Selected advisors receive this bounded context in their independent reasoning calls. It does not crawl the web or claim starter prompts are sourced research.

## Human-readable boundaries

- `app/page.tsx` and `app/globals.css`: browser room, whiteboard and native speech controls.
- `app/api/state`: reads local state.
- `app/api/session`: creates sessions and saves boards.
- `app/api/council`: validates a turn, saves the user message, runs the council and commits the result.
- `lib/council.ts`: selects relevant voices, generates independent viewpoints, synthesizes options and appends whiteboard items.
- `lib/advisors.ts`: generated starter interpretations.
- `lib/storage.ts`: validation, atomic local files and bounded knowledge.
- `lib/http.ts`: same-origin mutation guard and safe client errors.
- `lib/types.ts`: shared product data shapes.

Eve's official Next.js example informed the preference for small file-based modules. No Eve source was copied and no Eve runtime is installed. The inspected reference uses Apache-2.0; any future reuse must preserve its notices.

## Council and voice design

One configured reasoning model serves a small council workflow through AI SDK 7. The facilitator selects zero to two advisors using relevance, new perspective, persisted participation counts and recent turns. Explicit user selection takes priority. Each invited advisor reasons independently, then the facilitator summarizes disagreements and actionable options. This is differentiated prompting of one model, not claims about independent real people. User-owned decisions are not overwritten by model proposals.

A turn uses at most four bounded inference requests (selection, two advisors in parallel, synthesis), with no automatic retries and a 45-second timeout per request. A direct advisor invitation skips selection. A simple acknowledgment can invite nobody. Context includes the recent 30 messages, bounded board entries and matched notes; the full transcript remains in files. Each successful turn saves invitation reasons and participation counts. The UI explains who was invited and why.

ElevenLabs v4 Turbo is the primary planned high-quality output through a local outgoing Text-to-Dialogue WebSocket route. Set a server-only `ELEVENLABS_API_KEY` with Text to Speech and Voices read access; stock voices are retrieved from the account. Availability does not prove model access until a generation succeeds. Browser speech is an explicitly selected fallback.

Both output modes present contributions in a deterministic queue: one stock voice at a time. Start/end events drive the speaking avatar. Stop, microphone activation, a new turn, advisor selection and session changes interrupt playback. Individual stock voice choices save in `advisors.json`; inventories vary by browser/device, so distinct voices depend on availability. These are stock voices, not cloned or imitated voices of the named figures.

Realtime voice APIs remain an optional future upgrade, not installed infrastructure. One GPT-Live/Realtime session has a fixed voice; multi-voice council audio is simpler with separate TTS outputs. ElevenLabs output uses the same local workflow and sequential queue. ElevenAgents instead adds hosted orchestration/configuration; LiveKit adds a media server and worker or Cloud. Neither is required here. See [voice API design](https://developers.openai.com/api/docs/guides/voice-agents), [Realtime voice limitation](https://developers.openai.com/api/docs/guides/realtime-conversations), and [ElevenLabs TTS](https://elevenlabs.io/docs/api-reference/text-to-speech/stream).

Browser dictation and speech synthesis are optional platform features, not a realtime API integration. Recognition support varies; it may send microphone audio to a browser vendor service. Text and whiteboard editing work without microphone permission. Model API credentials stay on the server; no ChatGPT subscription credential is assumed.

This requires a persistent **local filesystem runtime**. Vercel tools do not make serverless deployment suitable for durable on-computer files. No database, sync, cloud storage or production cloud deployment is included.
