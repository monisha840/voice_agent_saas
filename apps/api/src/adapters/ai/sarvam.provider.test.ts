import { describe, it, expect } from "vitest";
import { SarvamSttProvider } from "./sarvam.stt.provider.js";
import { SarvamLlmProvider } from "./sarvam.llm.provider.js";
import { SarvamTtsProvider } from "./sarvam.tts.provider.js";
import { ProviderConfigError } from "../../shared/errors.js";

describe("Sarvam real providers (no SARVAM_API_KEY configured in this environment)", () => {
  it("SarvamSttProvider.transcribe throws ProviderConfigError, never a fake transcript", async () => {
    await expect(new SarvamSttProvider().transcribe(Buffer.from(""))).rejects.toBeInstanceOf(
      ProviderConfigError,
    );
  });

  it("SarvamLlmProvider.chat throws ProviderConfigError, never a fake response", async () => {
    await expect(
      new SarvamLlmProvider().chat([{ role: "user", content: "hi" }], []),
    ).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it("SarvamTtsProvider.synthesize throws ProviderConfigError, never fake audio", async () => {
    await expect(new SarvamTtsProvider().synthesize("hello")).rejects.toBeInstanceOf(ProviderConfigError);
  });
});
