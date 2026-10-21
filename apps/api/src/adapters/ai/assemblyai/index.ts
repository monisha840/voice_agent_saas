/**
 * EXPERIMENT entry point. The only thing the rest of the system imports from this directory.
 */
import { getConfig } from "../../../config/env.js";
import { ProviderConfigError } from "../../../shared/errors.js";
import { AssemblyAiSttProvider } from "./assemblyai.stt.provider.js";
import { ASSEMBLYAI_PROVIDER } from "./assemblyai.stt.streaming.js";

/** Builds the provider, refusing (loudly) when it is selected but not configured. Called only when explicitly selected. */
export function createAssemblyAiStt(): AssemblyAiSttProvider {
  const { assemblyai, realtime } = getConfig();
  if (!assemblyai.apiKey) {
    throw new ProviderConfigError(ASSEMBLYAI_PROVIDER, "REALTIME_STT_PROVIDER=assemblyai requires ASSEMBLYAI_API_KEY. Refusing to fall back to another provider.");
  }
  if (!realtime.sttStreaming) {
    throw new ProviderConfigError(ASSEMBLYAI_PROVIDER, "REALTIME_STT_PROVIDER=assemblyai is streaming-only and requires REALTIME_STT_STREAMING=true.");
  }
  return new AssemblyAiSttProvider();
}
