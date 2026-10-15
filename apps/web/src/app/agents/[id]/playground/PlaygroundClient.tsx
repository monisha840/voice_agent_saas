"use client";

import { useEffect, useRef, useState } from "react";
import { Send, Wrench } from "lucide-react";
import { createKnowledgeApi, type PlaygroundEvent } from "@/lib/knowledge";
import { Badge, Button, Card, Notice, errorMessage, inputClass } from "@/components/ui";

const knowledgeApi = createKnowledgeApi();

const SAMPLES = ["What are your timings?", "Is parking available?", "பார்க்கிங் இருக்கா?", "Price enna sir?"];

function Json({ value }: { value: unknown }) {
  return <pre className="mt-1 max-h-48 overflow-auto rounded bg-stone-50 p-2 text-xs text-stone-700">{JSON.stringify(value, null, 2)}</pre>;
}

/**
 * Text conversation with the saved agent through the real engine (same prompt, tools and knowledge as a phone call).
 * Nothing is dialed; replies are not spoken. Tool calls and their results are shown so behaviour can be explained.
 */
export function PlaygroundClient({ agent }: { agent: { id: string; name: string; personaName: string; language: string; status: string } }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<PlaygroundEvent[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"start" | "send" | "end" | null>(null);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events]);

  // Leaving the page ends the test conversation (best effort; the server also expires idle sessions).
  useEffect(() => {
    const end = () => {
      if (sessionRef.current) void knowledgeApi.endPlayground(sessionRef.current).catch(() => undefined);
    };
    window.addEventListener("pagehide", end);
    return () => {
      window.removeEventListener("pagehide", end);
      end();
    };
  }, []);

  async function start() {
    setBusy("start");
    setError(null);
    setEvents([]);
    setEnded(false);
    try {
      const s = await knowledgeApi.startPlayground(agent.id);
      setSessionId(s.sessionId);
      sessionRef.current = s.ended ? null : s.sessionId;
      setTools(s.effectiveTools);
      setEvents(s.events);
      setEnded(s.ended);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function send(message: string) {
    if (!sessionId || !message.trim()) return;
    setBusy("send");
    setError(null);
    setText("");
    setEvents((e) => [...e, { type: "caller", text: message.trim() }]);
    try {
      const r = await knowledgeApi.sendPlayground(sessionId, message.trim());
      // The server echoes the caller's line first; it is already shown.
      setEvents((e) => [...e, ...r.events.filter((x) => x.type !== "caller")]);
      if (r.ended) {
        setEnded(true);
        sessionRef.current = null;
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function end() {
    if (!sessionId) return;
    setBusy("end");
    try {
      await knowledgeApi.endPlayground(sessionId);
    } catch {
      /* already ended or expired */
    }
    sessionRef.current = null;
    setEnded(true);
    setEvents((e) => [...e, { type: "ended", reason: "You ended the conversation" }]);
    setBusy(null);
  }

  const visible = events.filter((e) => showTools || (e.type !== "tool_call" && e.type !== "tool_result"));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-stone-900">Test playground</h1>
          <p className="mt-1 text-sm text-stone-500">
            {agent.name}, speaking as {agent.personaName} · {agent.language}
          </p>
        </div>
        <Badge tone="info">Simulated · text only · nothing is dialed</Badge>
      </div>

      <Notice tone="info">
        This runs the saved agent through the real conversation engine (its prompt, tools and knowledge) with typed messages instead of a
        phone call. Save changes in the editor before testing. Replies are shown, not spoken, so voice and speech recognition are not tested
        here. English, Tamil and Tanglish work to the extent the configured language model supports them.
      </Notice>

      {agent.status !== "active" && <Notice tone="error">Archived agents cannot be tested. Unarchive the agent first.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <Card
        title="Conversation"
        action={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} className="h-4 w-4 accent-emerald-700" />
              Show tool calls
            </label>
            {sessionId && !ended ? (
              <Button variant="ghost" busy={busy === "end"} onClick={() => void end()}>
                End
              </Button>
            ) : (
              <Button busy={busy === "start"} disabled={agent.status !== "active"} onClick={() => void start()}>
                {sessionId ? "Start again" : "Start conversation"}
              </Button>
            )}
          </div>
        }
      >
        {!sessionId && busy !== "start" ? (
          <p className="text-sm text-stone-500">Start a conversation to hear the agent&apos;s opening line, then type as a caller would.</p>
        ) : (
          <div className="space-y-3" aria-live="polite">
            {busy === "start" && <p className="text-sm text-stone-500">Starting…</p>}
            {visible.map((e, i) => {
              if (e.type === "caller")
                return (
                  <div key={i} className="ml-auto max-w-[80%] rounded-lg bg-emerald-700 px-3 py-2 text-sm text-white">
                    {e.text}
                  </div>
                );
              if (e.type === "agent")
                return (
                  <div key={i} className="max-w-[80%] rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-900">
                    <span className="mb-0.5 block text-xs font-medium text-stone-500">{agent.personaName}</span>
                    {e.text}
                  </div>
                );
              if (e.type === "tool_call")
                return (
                  <div key={i} className="rounded-md border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-600">
                    <span className="inline-flex items-center gap-1 font-medium">
                      <Wrench size={12} /> Tool call: <span className="font-mono">{e.name}</span>
                    </span>
                    <Json value={e.arguments} />
                  </div>
                );
              if (e.type === "tool_result")
                return (
                  <div key={i} className="rounded-md border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-600">
                    <span className="font-medium">
                      Result of <span className="font-mono">{e.name}</span>
                    </span>
                    <Json value={e.result} />
                  </div>
                );
              if (e.type === "error")
                return (
                  <p key={i} role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                    Error: {e.message}
                  </p>
                );
              return (
                <p key={i} className="text-center text-xs text-stone-500">
                  {e.reason}
                </p>
              );
            })}
            {busy === "send" && <p className="text-sm text-stone-500">{agent.personaName} is replying…</p>}
            <div ref={bottom} />
          </div>
        )}

        {sessionId && !ended && (
          <div className="mt-4 space-y-2 border-t border-stone-100 pt-4">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <input
                className={`${inputClass} flex-1`}
                value={text}
                maxLength={500}
                placeholder="Type what the caller says…"
                aria-label="Caller message"
                onChange={(e) => setText(e.target.value)}
                disabled={busy !== null}
              />
              <Button type="submit" busy={busy === "send"} disabled={!text.trim()}>
                <Send size={14} />
                Send
              </Button>
            </form>
            <div className="flex flex-wrap gap-2">
              {SAMPLES.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void send(s)}
                  className="rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 hover:bg-stone-50 disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      {tools.length > 0 && (
        <p className="text-xs text-stone-500">
          Tools available in this conversation: <span className="font-mono">{tools.join(", ")}</span>
        </p>
      )}
    </div>
  );
}
