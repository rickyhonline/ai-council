"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Advisor, Board, Message, Session } from "@/lib/types";
import { latestCouncilContributions } from "@/lib/playback";

type StatePayload = {
  sessions: Session[];
  advisors: Advisor[];
  configured: boolean;
  configurationError?: string;
  model: string;
  models: CouncilModel[];
  defaultModel: string;
  dataPath: string;
};

type CouncilModel = {
  id: string;
  provider: "openai" | "anthropic";
  name: string;
  configured: boolean;
};

const MODEL_SELECTION_KEY = "ai-council:model";

type VoiceAdvisor = Advisor & { voiceURI?: string; elevenVoiceId?: string };
type VoiceMode = "elevenlabs" | "browser";
type ElevenVoice = { id: string; name: string };
type VoiceStatePayload = {
  configured: boolean;
  error?: string;
  model: "eleven_v4_turbo";
  voices: ElevenVoice[];
  assignments: Record<string, string>;
};
type CouncilTurn = {
  invited: string[];
  reason: string;
  participation: Record<string, number>;
  modelId?: string;
};

type RecognitionResultEvent = {
  results: ArrayLike<{ 0: { transcript: string } }>;
};

type RecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type RecognitionConstructor = new () => RecognitionInstance;

const EMPTY_BOARD: Board = {
  problem: "",
  ideas: [],
  questions: [],
  options: [],
  tradeoffs: [],
  decisions: [],
};

const BOARD_SECTIONS: Array<{
  key: Exclude<keyof Board, "problem">;
  label: string;
}> = [
  { key: "ideas", label: "Ideas" },
  { key: "questions", label: "Open questions" },
  { key: "options", label: "Options" },
  { key: "tradeoffs", label: "Tradeoffs" },
  { key: "decisions", label: "Decisions" },
];

function splitLines(value: string) {
  return value.split("\n");
}

function messageAdvisor(message: Message | undefined, advisors: Advisor[]) {
  if (!message || message.speaker.toLowerCase() === "user") return undefined;
  const speaker = message.speaker.toLowerCase();
  return advisors.find(
    (advisor) =>
      advisor.id.toLowerCase() === speaker ||
      advisor.name.toLowerCase() === speaker,
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l1.5 5.1L18 9l-4.5 1.9L12 16l-1.5-5.1L6 9l4.5-1.9L12 2Z" />
      <path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
    </svg>
  );
}

function AdvisorPortrait({ advisor }: { advisor: Advisor }) {
  return (
    <span
      className="portrait"
      style={{ "--advisor-color": advisor.color } as React.CSSProperties}
    >
      <span className="portrait-glow" />
      <span className="portrait-head">
        <span className="portrait-hair" />
        <span className="portrait-face">
          <span className="portrait-eyes" />
          <span className="portrait-mouth" />
        </span>
        <span className="portrait-body" />
      </span>
      <span className="portrait-initials">{advisor.initials}</span>
    </span>
  );
}

export default function Home() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [advisors, setAdvisors] = useState<Advisor[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [selectedAdvisorId, setSelectedAdvisorId] = useState("");
  const [configured, setConfigured] = useState(true);
  const [model, setModel] = useState("");
  const [models, setModels] = useState<CouncilModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [dataPath, setDataPath] = useState("");
  const [board, setBoard] = useState<Board>(EMPTY_BOARD);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [savingBoard, setSavingBoard] = useState(false);
  const [error, setError] = useState("");
  const [boardNotice, setBoardNotice] = useState("");
  const [configurationError, setConfigurationError] = useState("");
  const [recognitionSupported, setRecognitionSupported] = useState(false);
  const [synthesisSupported, setSynthesisSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("elevenlabs");
  const [voiceStateLoaded, setVoiceStateLoaded] = useState(false);
  const [elevenConfigured, setElevenConfigured] = useState(false);
  const [elevenConfigurationError, setElevenConfigurationError] = useState("");
  const [elevenVoices, setElevenVoices] = useState<ElevenVoice[]>([]);
  const [elevenAssignments, setElevenAssignments] = useState<
    Record<string, string>
  >({});
  const [voiceRuntimeError, setVoiceRuntimeError] = useState("");
  const [listening, setListening] = useState(false);
  const [readAloud, setReadAloud] = useState(false);
  const [activeContribution, setActiveContribution] = useState<Message | null>(
    null,
  );
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const [playbackActive, setPlaybackActive] = useState(false);
  const recognitionRef = useRef<RecognitionInstance | null>(null);
  const playbackQueueRef = useRef<Message[]>([]);
  const playbackTimerRef = useRef<number | null>(null);
  const playbackTokenRef = useRef(0);
  const voiceAbortRef = useRef<AbortController | null>(null);
  const councilAbortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () =>
      sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [sessions, activeSessionId],
  );
  const contributionAdvisor = messageAdvisor(
    activeContribution ?? undefined,
    advisors,
  );
  const selectedAdvisor = advisors.find(
    (advisor) => advisor.id === selectedAdvisorId,
  ) as VoiceAdvisor | undefined;
  const featuredAdvisor = activeContribution
    ? contributionAdvisor
    : selectedAdvisor;
  const selectedVoiceURI = selectedAdvisor?.voiceURI ?? "";
  const selectedVoiceAvailable =
    !selectedVoiceURI ||
    voices.some((voice) => voice.voiceURI === selectedVoiceURI);
  const selectedElevenVoiceId =
    selectedAdvisor?.elevenVoiceId ??
    (selectedAdvisor ? elevenAssignments[selectedAdvisor.id] : "") ??
    "";
  const selectedElevenVoiceAvailable =
    !selectedElevenVoiceId ||
    elevenVoices.some((voice) => voice.id === selectedElevenVoiceId);
  const selectedModel = models.find((item) => item.id === modelId);
  const lastTurn = (
    activeSession as (Session & { lastTurn?: CouncilTurn }) | undefined
  )?.lastTurn;
  const replayContributions = useMemo(
    () => latestCouncilContributions(activeSession?.messages ?? []),
    [activeSession?.messages],
  );

  const releaseElevenAudio = useCallback(() => {
    voiceAbortRef.current?.abort();
    voiceAbortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.onplay = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    councilAbortRef.current?.abort();
    councilAbortRef.current = null;
    setSending(false);
    playbackTokenRef.current += 1;
    playbackQueueRef.current = [];
    if (playbackTimerRef.current !== null) {
      window.clearTimeout(playbackTimerRef.current);
      playbackTimerRef.current = null;
    }
    releaseElevenAudio();
    window.speechSynthesis?.cancel();
    setSpeakerId(null);
    setActiveContribution(null);
    setPlaybackActive(false);
  }, [releaseElevenAudio]);

  const loadState = useCallback(async (keepSession = true) => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const payload = (await response.json()) as StatePayload & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "Could not open council data.");
      setSessions(payload.sessions);
      setAdvisors(payload.advisors);
      setConfigured(payload.configured);
      setConfigurationError(payload.configurationError ?? "");
      setModel(payload.model);
      const availableModels = payload.models ?? [];
      setModels(availableModels);
      let savedModelId: string | null = null;
      try {
        savedModelId = window.localStorage.getItem(MODEL_SELECTION_KEY);
      } catch {
        // Model selection still works when browser storage is unavailable.
      }
      setModelId(
        availableModels.find(
          (item) => item.id === savedModelId && item.configured,
        )?.id ??
          availableModels.find(
            (item) => item.id === payload.defaultModel && item.configured,
          )?.id ??
          availableModels.find((item) => item.configured)?.id ??
          payload.defaultModel ??
          "",
      );
      setDataPath(payload.dataPath);
      setActiveSessionId((current) =>
        keepSession &&
        payload.sessions.some((session) => session.id === current)
          ? current
          : (payload.sessions[0]?.id ?? ""),
      );
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not open council data.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const loadVoiceState = useCallback(async () => {
    try {
      const response = await fetch("/api/voice", { cache: "no-store" });
      const payload = (await response.json()) as Partial<VoiceStatePayload> & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error || "Could not load ElevenLabs voice configuration.",
        );
      }
      setElevenConfigured(Boolean(payload.configured));
      setElevenConfigurationError(payload.error ?? "");
      setElevenVoices(payload.voices ?? []);
      setElevenAssignments(payload.assignments ?? {});
    } catch (cause) {
      setElevenConfigured(false);
      setElevenConfigurationError(
        cause instanceof Error
          ? cause.message
          : "Could not load ElevenLabs voice configuration.",
      );
    } finally {
      setVoiceStateLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadState(false);
    void loadVoiceState();
    const speechWindow = window as typeof window & {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    setRecognitionSupported(
      Boolean(
        speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition,
      ),
    );
    setSynthesisSupported(
      "speechSynthesis" in window &&
        typeof window.SpeechSynthesisUtterance !== "undefined",
    );
    const updateVoices = () =>
      setVoices(window.speechSynthesis?.getVoices() ?? []);
    updateVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", updateVoices);
    return () =>
      window.speechSynthesis?.removeEventListener(
        "voiceschanged",
        updateVoices,
      );
  }, [loadState, loadVoiceState]);

  useEffect(() => {
    setBoard(activeSession?.board ?? EMPTY_BOARD);
  }, [activeSession]);

  useEffect(() => {
    if (activeSession?.messages.length || sending)
      transcriptEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }, [activeSession?.messages.length, sending]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      stopPlayback();
    };
  }, [stopPlayback]);

  function presentContributions(contributions: Message[]) {
    stopPlayback();
    if (!contributions.length) return;

    playbackQueueRef.current = [...contributions];
    const token = playbackTokenRef.current;
    const playbackSessionId = activeSession?.id;
    let elevenFailed = false;
    setPlaybackActive(true);

    const scheduleVisual = (contribution: Message, advance: () => void) => {
      setSpeakerId(null);
      const displayTime = Math.min(
        7000,
        Math.max(2400, 1600 + contribution.text.length * 24),
      );
      playbackTimerRef.current = window.setTimeout(() => {
        if (token !== playbackTokenRef.current) return;
        setActiveContribution(null);
        advance();
      }, displayTime);
    };

    const advance = () => {
      if (token !== playbackTokenRef.current) return;
      const contribution = playbackQueueRef.current.shift();
      if (!contribution) {
        setSpeakerId(null);
        setActiveContribution(null);
        setPlaybackActive(false);
        return;
      }

      setActiveContribution(contribution);
      const advisor = messageAdvisor(contribution, advisors);
      const identity = advisor?.id ?? contribution.speaker;

      if (
        readAloud &&
        voiceMode === "elevenlabs" &&
        !elevenFailed &&
        playbackSessionId
      ) {
        if (!elevenConfigured) {
          elevenFailed = true;
          scheduleVisual(contribution, advance);
          return;
        }

        const playElevenAudio = async () => {
          releaseElevenAudio();
          const controller = new AbortController();
          voiceAbortRef.current = controller;

          const fail = (message: string) => {
            if (token !== playbackTokenRef.current) return;
            elevenFailed = true;
            setVoiceRuntimeError(message);
            releaseElevenAudio();
            scheduleVisual(contribution, advance);
          };

          try {
            const response = await fetch("/api/voice", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sessionId: playbackSessionId,
                messageId: contribution.id,
              }),
              signal: controller.signal,
            });
            if (token !== playbackTokenRef.current) return;
            if (!response.ok) {
              let message =
                "ElevenLabs could not generate this voice response.";
              try {
                const payload = (await response.json()) as { error?: string };
                message = payload.error || message;
              } catch {
                // The voice endpoint normally returns JSON errors; retain the exact safe fallback.
              }
              fail(message);
              return;
            }

            const audioBlob = await response.blob();
            if (token !== playbackTokenRef.current) return;
            voiceAbortRef.current = null;
            const audioUrl = URL.createObjectURL(audioBlob);
            audioUrlRef.current = audioUrl;
            const audio = audioRef.current ?? new Audio();
            audioRef.current = audio;
            audio.preload = "auto";
            audio.src = audioUrl;

            let settled = false;
            const finish = () => {
              if (settled || token !== playbackTokenRef.current) return;
              settled = true;
              setSpeakerId(null);
              releaseElevenAudio();
              playbackTimerRef.current = window.setTimeout(() => {
                if (token !== playbackTokenRef.current) return;
                setActiveContribution(null);
                advance();
              }, 320);
            };
            const playbackFailure = () => {
              if (settled) return;
              settled = true;
              fail("ElevenLabs audio could not be played in this browser.");
            };
            audio.onplay = () => {
              if (token !== playbackTokenRef.current) return;
              setVoiceRuntimeError("");
              setSpeakerId(identity);
            };
            audio.onended = finish;
            audio.onerror = playbackFailure;
            void audio.play().catch(playbackFailure);
          } catch (cause) {
            if (controller.signal.aborted || token !== playbackTokenRef.current)
              return;
            fail(
              cause instanceof Error
                ? cause.message
                : "ElevenLabs could not generate this voice response.",
            );
          } finally {
            if (voiceAbortRef.current === controller) {
              voiceAbortRef.current = null;
            }
          }
        };

        void playElevenAudio();
        return;
      }

      if (readAloud && voiceMode === "browser" && synthesisSupported) {
        const utterance = new SpeechSynthesisUtterance(contribution.text);
        const language = (navigator.language || "en")
          .split("-")[0]
          ?.toLowerCase();
        const localVoices = voices.filter((voice) =>
          voice.lang.toLowerCase().startsWith(language),
        );
        const availableVoices = localVoices.length ? localVoices : voices;
        const advisorIndex = advisor
          ? Math.max(
              0,
              advisors.findIndex((item) => item.id === advisor.id),
            )
          : advisors.length;
        const savedVoiceURI = (advisor as VoiceAdvisor | undefined)?.voiceURI;
        const voice =
          voices.find((item) => item.voiceURI === savedVoiceURI) ??
          (availableVoices.length
            ? availableVoices[advisorIndex % availableVoices.length]
            : undefined);
        if (voice) utterance.voice = voice;
        utterance.rate = 0.96;

        let settled = false;
        const finish = () => {
          if (settled || token !== playbackTokenRef.current) return;
          settled = true;
          setSpeakerId(null);
          playbackTimerRef.current = window.setTimeout(() => {
            setActiveContribution(null);
            advance();
          }, 320);
        };
        utterance.onstart = () => {
          if (token === playbackTokenRef.current) setSpeakerId(identity);
        };
        utterance.onend = finish;
        utterance.onerror = finish;
        window.speechSynthesis.speak(utterance);
        return;
      }

      scheduleVisual(contribution, advance);
    };

    advance();
  }

  async function createSession() {
    stopPlayback();
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      const payload = (await response.json()) as Session & { error?: string };
      if (!response.ok)
        throw new Error(payload.error || "Could not create a session.");
      setSessions((current) => [payload, ...current]);
      setActiveSessionId(payload.id);
      setSelectedAdvisorId("");
      setDraft("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not create a session.",
      );
    }
  }

  async function saveBoard() {
    if (!activeSession) return;
    setSavingBoard(true);
    setBoardNotice("");
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "board",
          sessionId: activeSession.id,
          board: {
            ...board,
            ...Object.fromEntries(
              BOARD_SECTIONS.map(({ key }) => [
                key,
                board[key].map((line) => line.trim()).filter(Boolean),
              ]),
            ),
          },
        }),
      });
      const payload = (await response.json()) as Session & { error?: string };
      if (!response.ok)
        throw new Error(payload.error || "Could not save the whiteboard.");
      setSessions((current) =>
        current.map((session) =>
          session.id === payload.id ? payload : session,
        ),
      );
      setBoardNotice("Saved locally");
      window.setTimeout(() => setBoardNotice(""), 2200);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save the whiteboard.",
      );
    } finally {
      setSavingBoard(false);
    }
  }

  async function saveAdvisorVoice(advisorId: string, voiceURI: string) {
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "voice", advisorId, voiceURI }),
      });
      const payload = (await response.json()) as {
        advisors?: Advisor[];
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "Could not save that voice choice.");
      setAdvisors(
        (current) =>
          payload.advisors ??
          current.map((advisor) =>
            advisor.id === advisorId ? { ...advisor, voiceURI } : advisor,
          ),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save that voice choice.",
      );
    }
  }

  async function saveElevenAdvisorVoice(advisorId: string, voiceId: string) {
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "elevenVoice",
          advisorId,
          voiceId,
        }),
      });
      const payload = (await response.json()) as {
        advisors?: Advisor[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          payload.error || "Could not save that ElevenLabs voice choice.",
        );
      }
      setAdvisors(
        (current) =>
          payload.advisors ??
          current.map((advisor) =>
            advisor.id === advisorId
              ? { ...advisor, elevenVoiceId: voiceId }
              : advisor,
          ),
      );
      setElevenAssignments((current) => ({
        ...current,
        [advisorId]: voiceId,
      }));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save that ElevenLabs voice choice.",
      );
    }
  }

  async function askCouncil(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !activeSession || sending || !selectedModel?.configured)
      return;
    const submittedDraft = draft;
    const previousMessageIds = new Set(
      activeSession.messages.map((message) => message.id),
    );
    stopPlayback();
    const requestPlaybackToken = playbackTokenRef.current;
    const controller = new AbortController();
    councilAbortRef.current = controller;
    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/council", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSession.id,
          text,
          modelId,
          ...(selectedAdvisorId ? { advisorId: selectedAdvisorId } : {}),
        }),
        signal: controller.signal,
      });
      const payload = (await response.json()) as Session & { error?: string };
      if (controller.signal.aborted) return;
      if (!response.ok)
        throw new Error(payload.error || "The council could not respond.");
      setSessions((current) =>
        current.map((session) =>
          session.id === payload.id ? payload : session,
        ),
      );
      if (playbackTokenRef.current === requestPlaybackToken) {
        councilAbortRef.current = null;
        setSending(false);
        setDraft((current) => (current === submittedDraft ? "" : current));
        presentContributions(
          payload.messages.filter(
            (message) =>
              message.speaker.toLowerCase() !== "user" &&
              !previousMessageIds.has(message.id),
          ),
        );
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message =
        cause instanceof Error
          ? cause.message
          : "The council could not respond.";
      await loadState(true);
      if (!controller.signal.aborted) setError(message);
    } finally {
      if (councilAbortRef.current === controller) {
        councilAbortRef.current = null;
        setSending(false);
      }
    }
  }

  function toggleListening() {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const speechWindow = window as typeof window & {
      SpeechRecognition?: RecognitionConstructor;
      webkitSpeechRecognition?: RecognitionConstructor;
    };
    const Recognition =
      speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) return;
    stopPlayback();
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      setDraft((current) => `${current}${current ? " " : ""}${transcript}`);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      setError("Voice input stopped. You can keep typing your message.");
    };
    recognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      setListening(false);
      setError("Microphone input could not start. You can keep typing.");
    }
  }

  function selectAdvisor(advisor: Advisor) {
    stopPlayback();
    setSelectedAdvisorId((current) =>
      current === advisor.id ? "" : advisor.id,
    );
  }

  if (loading) {
    return (
      <main className="loading-screen">
        <span className="loading-orbit">
          <SparkIcon />
        </span>
        <p>Opening the council room…</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">
            <SparkIcon />
          </span>
          <div>
            <h1>AI Council</h1>
            <p>Council meeting</p>
          </div>
        </div>
        <div className="session-tools">
          <label className="sr-only" htmlFor="session-select">
            Current session
          </label>
          <select
            id="session-select"
            value={activeSession?.id ?? ""}
            onChange={(event) => {
              stopPlayback();
              setActiveSessionId(event.target.value);
              setSelectedAdvisorId("");
            }}
            disabled={!sessions.length}
          >
            {!sessions.length && <option value="">No sessions yet</option>}
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
          <button
            className="button secondary"
            type="button"
            onClick={() => void createSession()}
          >
            <span aria-hidden="true">＋</span> New session
          </button>
        </div>
      </header>

      {!configured && (
        <section className="config-banner" role="status">
          <span className="config-dot" />
          <div>
            <strong>
              {configurationError || "Council model access is not configured."}
            </strong>
            <span>
              Add an OpenAI or Anthropic key as described in{" "}
              <code>.env.example</code>. Your whiteboard and sessions still save
              to local files.
            </span>
          </div>
        </section>
      )}

      {voiceStateLoaded && voiceMode === "elevenlabs" && !elevenConfigured && (
        <section className="config-banner voice-config-banner" role="status">
          <span className="config-dot" />
          <div>
            <strong>
              ElevenLabs voice:{" "}
              {elevenConfigurationError || "voice access is not configured."}
            </strong>
            <span>
              Add the ElevenLabs key described in <code>.env.example</code>, or
              explicitly choose Browser fallback below.
            </span>
          </div>
        </section>
      )}

      {voiceRuntimeError && (
        <section className="error-banner voice-error-banner" role="alert">
          <span>ElevenLabs voice: {voiceRuntimeError}</span>
          <button
            type="button"
            onClick={() => setVoiceRuntimeError("")}
            aria-label="Dismiss ElevenLabs voice error"
          >
            ×
          </button>
        </section>
      )}

      {error && (
        <section className="error-banner" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError("")}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </section>
      )}

      <div className="workspace">
        <section className="shared-stage" aria-label="Shared whiteboard">
          <section className="whiteboard-card">
            <div className="card-header">
              <div>
                <span className="eyebrow">Shared workspace</span>
                <h2>Whiteboard</h2>
              </div>
              <div className="save-state" aria-live="polite">
                {boardNotice}
              </div>
            </div>
            <div className="board-scroll">
              <label className="board-problem">
                <span>Problem on the table</span>
                <textarea
                  value={board.problem}
                  onChange={(event) =>
                    setBoard((current) => ({
                      ...current,
                      problem: event.target.value,
                    }))
                  }
                  placeholder="What are we trying to solve?"
                  rows={3}
                  disabled={!activeSession}
                />
              </label>
              <div className="board-grid">
                {BOARD_SECTIONS.map((section) => (
                  <label
                    className={`board-note ${section.key}`}
                    key={section.key}
                  >
                    <span>{section.label}</span>
                    <textarea
                      value={board[section.key].join("\n")}
                      onChange={(event) =>
                        setBoard((current) => ({
                          ...current,
                          [section.key]: splitLines(event.target.value),
                        }))
                      }
                      placeholder="One item per line"
                      rows={4}
                      disabled={!activeSession}
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="board-footer">
              <span title={dataPath}>
                {dataPath
                  ? "Saved to local files"
                  : "Local data path unavailable"}
              </span>
              <button
                className="button board-save"
                type="button"
                onClick={() => void saveBoard()}
                disabled={!activeSession || savingBoard}
              >
                {savingBoard ? "Saving…" : "Save board"}
              </button>
            </div>
          </section>
        </section>
        <aside
          className="meeting-rail"
          aria-label="Meeting participants and speaker view"
        >
          <div className="rail-heading">
            <h2>Speaker view</h2>
            <span>{advisors.length + 1} participants</span>
          </div>
          <section
            className={`speaker-view ${speakerId ? "is-speaking" : ""}`}
            aria-label="Active speaker"
          >
            <span className="speaker-status">
              {sending
                ? "Thinking"
                : speakerId
                  ? "Speaking"
                  : activeContribution
                    ? "Presenting"
                    : "Ready"}
            </span>
            <div
              className="speaker-portrait"
              style={
                {
                  "--advisor-color": featuredAdvisor?.color ?? "#6c8dff",
                } as React.CSSProperties
              }
            >
              {featuredAdvisor ? (
                <AdvisorPortrait advisor={featuredAdvisor} />
              ) : (
                <span className="facilitator-avatar">
                  <SparkIcon />
                </span>
              )}
            </div>
            <div className="speaker-name">
              <strong>
                {activeContribution && !contributionAdvisor
                  ? "Council facilitator"
                  : (contributionAdvisor?.name ??
                    selectedAdvisor?.name ??
                    "Council facilitator")}
              </strong>
              <span>AI participant</span>
            </div>
          </section>
          {activeContribution && (
            <div className="speaker-caption" role="status">
              <strong>
                {contributionAdvisor?.name ?? "Council facilitator"}
              </strong>
              <p>{activeContribution.text}</p>
            </div>
          )}
          <div className="participant-heading">
            <span>Participants</span>
            <small>Select someone to invite</small>
          </div>
          <div
            className="advisor-ring"
            role="group"
            aria-label="Council advisors"
          >
            {advisors.map((advisor) => {
              const selected = advisor.id === selectedAdvisorId;
              const presenting = advisor.id === contributionAdvisor?.id;
              const speaking = advisor.id === speakerId;
              return (
                <button
                  key={advisor.id}
                  type="button"
                  className={`advisor-seat ${selected ? "selected" : ""} ${presenting ? "presenting" : ""} ${speaking ? "speaking" : ""}`}
                  style={
                    {
                      "--advisor-color": advisor.color,
                    } as React.CSSProperties
                  }
                  onClick={() => selectAdvisor(advisor)}
                  aria-pressed={selected}
                  aria-label={`${selected ? "Stop addressing" : "Address"} ${advisor.name}, ${advisor.role}`}
                >
                  <AdvisorPortrait advisor={advisor} />
                  <span className="advisor-copy">
                    <strong>{advisor.name}</strong>
                    <small>{advisor.role}</small>
                  </span>
                  <span className="advisor-state">
                    {speaking
                      ? "Speaking"
                      : presenting
                        ? "Presenting"
                        : selected
                          ? "Selected"
                          : "Invite"}
                  </span>
                </button>
              );
            })}
            {!advisors.length && (
              <p className="empty-advisors">
                Advisor configuration could not be loaded.
              </p>
            )}
          </div>

          <div className="addressing-line" aria-live="polite">
            <span>
              {selectedAdvisor ? (
                <>
                  Addressing <strong>{selectedAdvisor.name}</strong>. Select
                  again to ask the whole council.
                </>
              ) : (
                <>The facilitator will invite the most relevant perspectives.</>
              )}
            </span>
            {selectedAdvisor &&
              voiceMode === "elevenlabs" &&
              elevenVoices.length > 0 && (
                <label
                  className="voice-assignment"
                  title={
                    selectedElevenVoiceAvailable
                      ? "High-quality ElevenLabs voice. This does not imitate the advisor."
                      : "The saved ElevenLabs voice is unavailable; the server default will be used."
                  }
                >
                  <span>ElevenLabs voice</span>
                  <select
                    value={
                      selectedElevenVoiceAvailable ? selectedElevenVoiceId : ""
                    }
                    onChange={(event) => {
                      stopPlayback();
                      void saveElevenAdvisorVoice(
                        selectedAdvisor.id,
                        event.target.value,
                      );
                    }}
                    aria-label={`ElevenLabs voice for ${selectedAdvisor.name}`}
                  >
                    <option value="">Server default</option>
                    {elevenVoices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            {selectedAdvisor &&
              voiceMode === "browser" &&
              synthesisSupported &&
              voices.length > 0 && (
                <label
                  className="voice-assignment"
                  title={
                    selectedVoiceAvailable
                      ? "Installed voice lists differ by browser and computer."
                      : "This saved voice is unavailable here, so an installed fallback will be used."
                  }
                >
                  <span>Browser voice</span>
                  <select
                    value={selectedVoiceAvailable ? selectedVoiceURI : ""}
                    onChange={(event) => {
                      stopPlayback();
                      void saveAdvisorVoice(
                        selectedAdvisor.id,
                        event.target.value,
                      );
                    }}
                    aria-label={`Stock voice for ${selectedAdvisor.name}`}
                  >
                    <option value="">Automatic</option>
                    {voices.map((voice) => (
                      <option
                        key={`${voice.voiceURI}-${voice.lang}`}
                        value={voice.voiceURI}
                      >
                        {voice.name} · {voice.lang}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            {lastTurn?.reason && (
              <small className="turn-reason" title={lastTurn.reason}>
                Last turn: {lastTurn.reason}
              </small>
            )}
          </div>

          <details className="meeting-chat">
            <summary>
              Conversation <span>{activeSession?.messages.length ?? 0}</span>
            </summary>
            <section className="transcript-card">
              <div className="card-header transcript-header">
                <div>
                  <span className="eyebrow">Meeting notes</span>
                  <h2>Conversation</h2>
                </div>
                {(lastTurn?.modelId || modelId || model) && (
                  <span
                    className="model-chip"
                    title={lastTurn?.modelId || modelId || model}
                  >
                    {lastTurn?.modelId || modelId || model}
                  </span>
                )}
              </div>
              <div
                className="transcript"
                role="log"
                aria-live="polite"
                aria-relevant="additions text"
              >
                {!activeSession?.messages.length && (
                  <div className="empty-transcript">
                    <span>
                      <SparkIcon />
                    </span>
                    <strong>The table is open.</strong>
                    <p>
                      Share what is on your mind. The facilitator will bring in
                      useful viewpoints and capture what matters.
                    </p>
                  </div>
                )}
                {activeSession?.messages.map((message) => {
                  const advisor = messageAdvisor(message, advisors);
                  const isUser = message.speaker.toLowerCase() === "user";
                  return (
                    <article
                      className={`message ${isUser ? "user-message" : "advisor-message"} ${activeContribution?.id === message.id ? "active-message" : ""}`}
                      key={message.id}
                      aria-current={
                        activeContribution?.id === message.id
                          ? "true"
                          : undefined
                      }
                    >
                      <div className="message-meta">
                        <span
                          className="message-avatar"
                          style={
                            {
                              "--advisor-color": advisor?.color ?? "#d4ff63",
                            } as React.CSSProperties
                          }
                        >
                          {isUser ? "YOU" : (advisor?.initials ?? "AI")}
                        </span>
                        <strong>
                          {isUser
                            ? "You"
                            : (advisor?.name ?? "Council facilitator")}
                        </strong>
                        <time dateTime={message.createdAt}>
                          {formatTime(message.createdAt)}
                        </time>
                      </div>
                      <p>{message.text}</p>
                    </article>
                  );
                })}
                {sending && (
                  <div className="thinking-message" role="status">
                    <span />
                    <span />
                    <span />
                    <p>
                      {selectedAdvisorId
                        ? "An advisor is considering your question"
                        : "The facilitator is choosing the right voices"}
                    </p>
                  </div>
                )}
                <div ref={transcriptEndRef} />
              </div>
            </section>
          </details>
        </aside>
      </div>
      <div className="meeting-dock">
        <form className="composer" onSubmit={askCouncil}>
          <div className="model-control-row">
            <label className="model-control" htmlFor="council-model">
              <span>Council model</span>
              <select
                id="council-model"
                value={modelId}
                disabled={!models.some((item) => item.configured)}
                onChange={(event) => {
                  stopPlayback();
                  setModelId(event.target.value);
                  try {
                    window.localStorage.setItem(
                      MODEL_SELECTION_KEY,
                      event.target.value,
                    );
                  } catch {
                    // A blocked storage setting must not prevent selecting a model.
                  }
                }}
                aria-describedby="model-selection-note"
              >
                {!models.length && (
                  <option value="">No models available</option>
                )}
                {models.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={!item.configured}
                  >
                    {item.provider === "openai" ? "OpenAI" : "Anthropic"} ·{" "}
                    {item.name}
                    {!item.configured ? " · key required" : ""}
                  </option>
                ))}
              </select>
            </label>
            <small id="model-selection-note">
              Choose the model for your next council turn.
            </small>
          </div>
          <label htmlFor="council-message" className="sr-only">
            Message the council
          </label>
          <textarea
            id="council-message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              activeSession
                ? "Bring a decision, problem, or half-formed idea to the table…"
                : "Create a session to begin…"
            }
            rows={2}
            disabled={!activeSession}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="composer-actions">
            <div className="voice-tools">
              <button
                className={`icon-button ${listening ? "live" : ""}`}
                type="button"
                onClick={toggleListening}
                disabled={!recognitionSupported || !activeSession}
                aria-pressed={listening}
                title={
                  recognitionSupported
                    ? "Dictate with your browser. Speech may be processed by your browser vendor."
                    : "Voice input is not supported in this browser."
                }
              >
                <MicIcon /> <span>{listening ? "Listening…" : "Speak"}</span>
              </button>
              <label className="voice-mode-control">
                <span>Voice</span>
                <select
                  value={voiceMode}
                  onChange={(event) => {
                    stopPlayback();
                    setVoiceRuntimeError("");
                    setVoiceMode(event.target.value as VoiceMode);
                  }}
                  aria-label="Reply voice service"
                >
                  <option value="elevenlabs">ElevenLabs · v4 Turbo</option>
                  <option value="browser">Browser fallback</option>
                </select>
              </label>
              <label
                className={`voice-toggle ${voiceMode === "browser" && !synthesisSupported ? "unavailable" : ""}`}
                title={
                  voiceMode === "elevenlabs"
                    ? "High-quality ElevenLabs v4 Turbo audio. Replies remain silent when ElevenLabs is unavailable."
                    : synthesisSupported
                      ? "Fallback uses installed browser voices."
                      : "Browser voice fallback is not supported here."
                }
              >
                <input
                  type="checkbox"
                  checked={readAloud}
                  disabled={voiceMode === "browser" && !synthesisSupported}
                  onChange={(event) => {
                    stopPlayback();
                    setReadAloud(event.target.checked);
                  }}
                />
                <span className="toggle-track">
                  <span />
                </span>
                Read replies aloud
              </label>
              {replayContributions.length > 0 && (
                <button
                  className="playback-replay"
                  type="button"
                  onClick={() => presentContributions(replayContributions)}
                  disabled={sending}
                  title="Replay the latest persisted council contributions"
                >
                  <span aria-hidden="true">↻</span> Replay last turn
                </button>
              )}
              {(playbackActive || sending) && (
                <button
                  className="playback-stop"
                  type="button"
                  onClick={stopPlayback}
                >
                  <span aria-hidden="true" />{" "}
                  {sending ? "Stop response" : "Stop"}
                </button>
              )}
            </div>
            <button
              className="button primary"
              type="submit"
              disabled={
                !draft.trim() ||
                !activeSession ||
                sending ||
                !selectedModel?.configured
              }
            >
              <SparkIcon /> {sending ? "Convening…" : "Ask the council"}
            </button>
          </div>
        </form>{" "}
      </div>
      <p className="council-disclosure">
        AI interpretations inspired by these figures, not the real people.
        Generated perspectives; source research pending.
      </p>
    </main>
  );
}
