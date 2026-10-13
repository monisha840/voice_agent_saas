"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, apiBase } from "@/lib/api";
import type { CallDetail } from "@/lib/types";
import { Button, Card, Notice, errorMessage } from "@/components/ui";
import { CallStatusBadge } from "@/components/CallStatusBadge";
import { LoadingState } from "@/components/StateViews";

/**
 * Web call: talk to an agent with your microphone, no phone line. The page plays the part Exotel plays on a real call
 * and speaks the same stream protocol (connected / start / media / mark / stop; 16-bit 8 kHz mono PCM, base64), so the
 * server runs exactly the pipeline a phone call runs. Temporary channel until Exotel AgentStream is enabled.
 */
const RATE = 8000;
const FRAME_SAMPLES = 800; // 100 ms
const POLL_MS = 2000;

// Runs on the audio thread: resamples the microphone to 8 kHz and hands back 100 ms Int16 frames.
const WORKLET = `
class Downsampler extends AudioWorkletProcessor {
  constructor() { super(); this.pos = 0; this.buf = []; this.ratio = sampleRate / ${RATE}; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const a = ch[i], b = i + 1 < ch.length ? ch[i + 1] : a;
      const v = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.buf.push(v < 0 ? v * 32768 : v * 32767);
      if (this.buf.length === ${FRAME_SAMPLES}) {
        this.port.postMessage(Int16Array.from(this.buf).buffer);
        this.buf = [];
      }
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("downsampler", Downsampler);
`;

function b64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Phase = "idle" | "connecting" | "live" | "ended";

export function WebCallRun({ agentId, leadId }: { agentId: string; leadId?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [call, setCall] = useState<CallDetail | null>(null);
  const [agentSpeaking, setAgentSpeaking] = useState(false);

  const session = useRef<{ stop: () => void } | null>(null);
  const poller = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (poller.current) clearInterval(poller.current);
    poller.current = null;
  }
  useEffect(
    () => () => {
      session.current?.stop();
      stopPolling();
    },
    [],
  );

  function poll(id: string) {
    stopPolling();
    const tick = async () => {
      try {
        const latest = await api.getCall(id);
        setCall(latest);
        if (latest.status === "completed" || latest.status === "failed") stopPolling();
      } catch {
        // transient; keep polling
      }
    };
    void tick();
    poller.current = setInterval(() => void tick(), POLL_MS);
  }

  async function start() {
    setError(null);
    setCall(null);
    setPhase("connecting");
    let mic: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let ws: WebSocket | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser cannot use the microphone here (open the dashboard on http://localhost:3000 or https).");
      }
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ctx = new AudioContext();
      await ctx.resume();
      const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const created = await api.createWebCall({ agentId, ...(leadId ? { leadId } : {}) });
      setCallId(created.callId);
      poll(created.callId);

      const audioCtx = ctx;
      const micStream = mic;
      const streamSid = `web-${created.callId}`;
      const url = `${apiBase().replace(/^http/, "ws")}/api/web-call/stream?callId=${created.callId}`;
      ws = new WebSocket(url);
      const socket = ws;
      let chunk = 0;
      let nextPlayAt = 0;
      let live = false;
      let stopped = false;
      const playing = new Set<AudioBufferSourceNode>();
      const markTimers = new Set<ReturnType<typeof setTimeout>>();

      const send = (frame: Record<string, unknown>) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
      };

      const source = audioCtx.createMediaStreamSource(micStream);
      const node = new AudioWorkletNode(audioCtx, "downsampler");
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        if (!live) return;
        chunk += 1;
        send({
          event: "media",
          stream_sid: streamSid,
          media: { chunk: String(chunk), timestamp: String(chunk * 100), payload: b64FromBytes(new Uint8Array(e.data)) },
        });
      };
      const mute = audioCtx.createGain(); // keeps the node running without playing the microphone back
      mute.gain.value = 0;
      source.connect(node).connect(mute).connect(audioCtx.destination);

      const flushPlayback = () => {
        playing.forEach((s) => {
          try {
            s.stop();
          } catch {
            // already finished
          }
        });
        playing.clear();
        markTimers.forEach((t) => clearTimeout(t));
        markTimers.clear();
        nextPlayAt = 0;
        setAgentSpeaking(false);
      };

      const teardown = () => {
        if (stopped) return;
        stopped = true;
        live = false;
        flushPlayback();
        try {
          node.port.onmessage = null;
          source.disconnect();
        } catch {
          // ignore
        }
        micStream.getTracks().forEach((t) => t.stop());
        void audioCtx.close().catch(() => undefined);
        session.current = null;
        setPhase("ended");
      };

      session.current = {
        stop: () => {
          send({ event: "stop", stream_sid: streamSid, stop: { reason: "hangup" } });
          try {
            socket.close();
          } catch {
            // ignore
          }
          teardown();
        },
      };

      socket.onopen = () => {
        send({ event: "connected" });
        send({
          event: "start",
          stream_sid: streamSid,
          start: {
            stream_sid: streamSid,
            call_sid: streamSid,
            account_sid: "web",
            media_format: { encoding: "pcm_s16le", sample_rate: String(RATE), bit_rate: "128kbps" },
          },
        });
        live = true;
        setPhase("live");
      };

      socket.onmessage = (e) => {
        let f: { event?: string; media?: { payload?: string }; mark?: { name?: string } };
        try {
          f = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (f.event === "media" && f.media?.payload) {
          const bytes = bytesFromB64(f.media.payload);
          const n = Math.floor(bytes.length / 2);
          if (n === 0) return;
          const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
          const buf = audioCtx.createBuffer(1, n, RATE);
          const data = buf.getChannelData(0);
          for (let i = 0; i < n; i++) data[i] = view.getInt16(i * 2, true) / 32768;
          const src = audioCtx.createBufferSource();
          src.buffer = buf;
          src.connect(audioCtx.destination);
          const at = Math.max(audioCtx.currentTime + 0.05, nextPlayAt);
          src.start(at);
          nextPlayAt = at + buf.duration;
          playing.add(src);
          src.onended = () => playing.delete(src);
          setAgentSpeaking(true);
        } else if (f.event === "mark" && f.mark?.name) {
          // Tell the server the audio queued before this mark has finished playing.
          const name = f.mark.name;
          const wait = Math.max(0, (nextPlayAt - audioCtx.currentTime) * 1000) + 30;
          const t = setTimeout(() => {
            markTimers.delete(t);
            send({ event: "mark", stream_sid: streamSid, mark: { name } });
            if (markTimers.size === 0) setAgentSpeaking(false);
          }, wait);
          markTimers.add(t);
        } else if (f.event === "clear") {
          flushPlayback(); // the caller talked over the agent: drop what is still queued
        }
      };

      socket.onerror = () => setError("The connection to the server failed.");
      socket.onclose = () => teardown();
    } catch (err) {
      mic?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      ws?.close();
      setError(errorMessage(err));
      setPhase("idle");
    }
  }

  const running = phase === "connecting" || phase === "live";
  const finished = call?.status === "completed" || call?.status === "failed";
  const transcript = call?.conversation?.transcript ?? [];

  return (
    <div className="space-y-6">
      <Card title="Web call">
        <div className="space-y-4">
          <p className="text-sm text-stone-500">
            Talk to the agent with your microphone. Use headphones: speaker audio can be picked up by the microphone and
            heard by the agent. The browser will ask for microphone permission.
          </p>
          <div className="flex items-center gap-3">
            {running ? (
              <Button variant="secondary" busy={phase === "connecting"} disabled={phase === "connecting"} onClick={() => session.current?.stop()}>
                {phase === "connecting" ? "Connecting…" : "Hang up"}
              </Button>
            ) : (
              <Button onClick={() => void start()}>
                {phase === "ended" ? "Call again" : "Start web call"}
              </Button>
            )}
            {phase === "live" && (
              <span className="text-sm text-stone-600">{agentSpeaking ? "Agent is speaking…" : "Listening…"}</span>
            )}
          </div>
        </div>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      {callId && (
        <Card title="Live call" action={call ? <CallStatusBadge status={call.status} /> : undefined}>
          {!call ? (
            <LoadingState label="Starting call…" />
          ) : (
            <div className="space-y-3">
              {transcript.length === 0 ? (
                <p className="text-sm text-stone-500">{finished ? "No transcript recorded." : "Waiting for the conversation…"}</p>
              ) : (
                <ol className="space-y-3">
                  {transcript.map((t, i) => (
                    <li key={i} className="text-sm">
                      <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
                        {t.speaker === "ai" ? "Agent" : "Caller"}
                      </span>
                      <span className="text-stone-800">{t.text}</span>
                    </li>
                  ))}
                </ol>
              )}
              {finished && (
                <Link href={`/calls/${callId}`} className="inline-block text-sm font-medium text-emerald-700 hover:text-emerald-800">
                  Open call details
                </Link>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
