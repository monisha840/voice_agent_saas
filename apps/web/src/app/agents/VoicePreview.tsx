"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button, Notice, errorMessage } from "@/components/ui";

/**
 * "Hear this voice": asks the server for a short sample in the typed voice name and plays it. A name the speech
 * provider does not know is reported here, so a typo cannot silently leave the agent on the default (male) voice.
 */
export function VoicePreview({ voice, language }: { voice: string; language: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  async function play() {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const r = await api.previewVoice(voice.trim(), language);
      const bytes = Uint8Array.from(atob(r.audioBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: r.format === "mp3" ? "audio/mpeg" : "audio/wav" }));
      audio.current?.pause();
      const el = new Audio(url);
      audio.current = el;
      el.onended = () => URL.revokeObjectURL(url);
      await el.play();
      setOk(`Playing "${r.voice}". If this is not the voice you want, try another name.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <Button variant="secondary" busy={busy} disabled={voice.trim() === ""} onClick={() => void play()}>
        Hear this voice
      </Button>
      {error && <Notice tone="error">{error}</Notice>}
      {ok && !error && <Notice tone="success">{ok}</Notice>}
    </div>
  );
}
