# EXPERIMENT: AssemblyAI realtime STT

Status: experimental, opt-in, English only. **Sarvam remains the default and the production path.**

Purpose: benchmark AssemblyAI streaming STT against Sarvam streaming STT (latency, stability, English / Indian English
on phone-quality audio). It plugs into the existing `ISpeechToText` streaming interface; the realtime engine, turn
controller, coordinator, ConversationSession, LLM, TTS and Exotel are untouched and provider-neutral.

## Turning it on

```
REALTIME_STT_PROVIDER=assemblyai      # default: sarvam
REALTIME_STT_STREAMING=true           # required (the adapter is streaming-only)
ASSEMBLYAI_API_KEY=...                # required; missing => startup validation error / the call is refused. No fallback.
ASSEMBLYAI_STT_MODEL=universal-streaming-english   # default; see "Models" below
```

Never automatic: a key being present does not select it, and neither provider ever falls back to the other.

## Contract used (AssemblyAI Streaming API v3, from the published docs; not yet run against a live account)

| | |
|---|---|
| Endpoint | `wss://streaming.assemblyai.com/v3/ws` (`ASSEMBLYAI_STT_URL`) |
| Auth | `Authorization: <key>` header, no "Bearer"; never in the URL or logs |
| Query | `speech_model`, `encoding=pcm_s16le`, `sample_rate`, `format_turns=true`, `min_turn_silence`, `max_turn_silence` |
| Client sends | binary PCM frames of 50-1000 ms; `{"type":"ForceEndpoint"}`; `{"type":"Terminate"}` |
| Server sends | `Begin`, `SpeechStarted`, `Turn` (`end_of_turn`, `turn_is_formatted`, `turn_order`, `transcript`), `Termination`, `Error {error_code,error}` |

## Audio

Internal format (PCM s16le, mono, 8 kHz) is sent **as is**: `sample_rate=8000` is accepted directly (service range
8000-96000), so there is **no resampling** and no encoding change. The only transformation is framing to the service's
50-1000 ms rule: fragments under 50 ms are joined, runs over 1000 ms are split, and the tail of an utterance is padded
with silence to 50 ms.

## Who decides when a turn ends

Our turn controller. `speech_end` becomes `ForceEndpoint`; the provider's own endpointing is pushed far out
(`min_turn_silence` 5000 ms, `max_turn_silence` 8000 ms). If the service nevertheless ends a turn mid-utterance, that
final is **held** and joined to the one `ForceEndpoint` produces, so the application sees exactly one final per
utterance. Finals are deduplicated by `turn_order`, and only `end_of_turn && turn_is_formatted` counts (Universal
Streaming with `format_turns=true` sends an unformatted and a formatted final for the same turn).

## Known limitations / unverified

- Not run against the live service. Verify with the opt-in integration test and the benchmark.
- Behaviour of `ForceEndpoint` when nothing is pending is not documented. If it sends nothing, held text is settled after
  `ASSEMBLYAI_STT_FLUSH_GRACE_MS` (default 2000), which would add that delay to such turns.
- The interplay of `min_turn_silence` / `max_turn_silence` with each model is untested; models differ in which
  parameters they honour (the service ignores unknown ones, and the adapter checks `Begin.configuration.model`).
- WebSocket close codes and a general error schema are not documented; only `Error.error_code` 3006/3007/3008 are mapped.
- **Free-tier rate limit (observed, then confirmed in the docs):** 5 NEW streaming sessions per minute; more are refused
  with error 1008 ("Too many concurrent sessions"), mapped to `rate_limited`. It is a new-session rate, not a concurrency
  cap, and it matters for our one-session-per-call design: a paid plan (100+/min, auto-scaling) is needed for any real
  call volume. The benchmark paces itself (13 s between sessions) for this reason.
- **Tamil is not supported** by AssemblyAI streaming. A Tamil agent is refused up front with a clear error.
- **Billing is by session wall-clock time.** The coordinator keeps one session open per call, so silent stretches and
  agent speech are billed. Cost has not been compared.
- Models: default `universal-streaming-english` (English only, GA). `universal-3-6-pro` / `universal-3-5-pro` /
  `universal-streaming-multilingual` can be set via `ASSEMBLYAI_STT_MODEL`; availability and language lists vary by account.

## Benchmark

```
pnpm --filter @voice-agent/api exec tsx src/scripts/stt-benchmark.ts --audio-dir ./bench-audio --runs 5
```

Fixtures (`english.wav`, `indian-english.wav`, `mixed-exploratory.wav`, `tamil.wav`) live in the git-ignored
`apps/api/bench-audio/` (or are synthesized with `--synthesize`: synthetic speech, plumbing and timing only). Tamil is run
for Sarvam only. Mixed Tamil-English is exploratory for AssemblyAI. Only measured values are printed.

Real-service integration test: `ASSEMBLYAI_STT_INTEGRATION=1 ASSEMBLYAI_API_KEY=... pnpm --filter @voice-agent/api test assemblyai.stt.integration`.

## Removing the experiment

Delete:

- `apps/api/src/adapters/ai/assemblyai/` (adapter, provider, entry point, tests, integration test, this document)
- `apps/api/src/scripts/stt-benchmark.ts`, `stt-benchmark-report.ts`, `stt-benchmark-report.test.ts` (the benchmark also runs Sarvam; keep these if you want a Sarvam-only benchmark and drop the AssemblyAI lines)

Then revert the small hooks:

- `apps/api/src/adapters/ai/index.ts`: the `createAssemblyAiStt` import and the `realtime.sttProvider === "assemblyai"` branch in `getSttProvider()`
- `apps/api/src/config/env.ts`: `assemblyai` config block and `realtime.sttProvider`
- `apps/api/src/config/validate.ts`: the `REALTIME_STT_PROVIDER=assemblyai` checks
- `.env.example` (AssemblyAI block) and `.gitignore` (`bench-audio/`)

Nothing else references it. The provider-neutral additions made alongside (STT provider label and session-end logging in
`realtime/stt-stream.ts`, `sttProvider` in turn metrics, the "STT provider unavailable" guard in the Exotel handler) are
generally useful and can stay.
