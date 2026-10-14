import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { voicePreviewService } from "./voice-preview.js";
import { setTtsProvider } from "../../adapters/ai/index.js";
import type { ITextToSpeech, TtsOptions, TtsResult } from "../../adapters/ai/tts.interface.js";
import { ProviderRequestError } from "../../shared/errors.js";
import { userContext, type RequestContext } from "../../auth/context.js";
import { cleanupTenants, createMember, createTenant } from "../../test/tenants.js";

const seen: Array<{ text: string; voice?: string; languageCode?: string }> = [];
const provider = (known: string[]): ITextToSpeech => ({
  name: "voice-test",
  capabilities: { voiceSelection: true },
  async synthesize(text: string, opts?: TtsOptions): Promise<TtsResult> {
    seen.push({ text, voice: opts?.voice, languageCode: opts?.languageCode });
    if (opts?.voice && !known.includes(opts.voice)) {
      throw new ProviderRequestError("voice-test", "voice-test tts.synthesize failed (HTTP 400)", undefined, { category: "invalid_request", operation: "tts.synthesize", status: 400 });
    }
    return { audio: Buffer.from("RIFFfake"), format: "wav" };
  },
});

let owner: RequestContext;
let agentUser: RequestContext;
beforeAll(async () => {
  const t = await createTenant("VPV");
  owner = userContext(t.orgId, t.userId, "OWNER");
  const m = await createMember(t.orgId, "AGENT");
  agentUser = userContext(t.orgId, m.userId, "AGENT");
});
afterAll(async () => {
  await cleanupTenants();
});
afterEach(() => {
  setTtsProvider(null);
  seen.length = 0;
});

describe("voice preview", () => {
  it("plays a sample in the named voice and language", async () => {
    setTtsProvider(provider(["ritu"]));
    const r = await voicePreviewService.preview(owner, { voice: "ritu", language: "ta-IN" });
    expect(r).toMatchObject({ voice: "ritu", languageCode: "ta-IN", format: "wav" });
    expect(Buffer.from(r.audioBase64, "base64").toString()).toBe("RIFFfake");
    expect(seen[0]).toMatchObject({ voice: "ritu", languageCode: "ta-IN" });
    expect(seen[0].text).toMatch(/[஀-௿]/);
  });

  it("a voice name the provider does not know is an error, not a silent fallback", async () => {
    setTtsProvider(provider(["ritu"]));
    await expect(voicePreviewService.preview(owner, { voice: "no-such-speaker" })).rejects.toThrow(/does not know a voice called/);
    expect(seen).toHaveLength(1); // one attempt: no retry on the default voice
  });

  it("an unsupported language falls back to the English sample", async () => {
    setTtsProvider(provider(["ritu"]));
    const r = await voicePreviewService.preview(owner, { voice: "ritu", language: "xx-YY" });
    expect(r.languageCode).toBe("en-IN");
  });

  it("is for people who manage agents", async () => {
    setTtsProvider(provider(["ritu"]));
    await expect(voicePreviewService.preview(agentUser, { voice: "ritu" })).rejects.toThrow();
  });

  it("refuses an empty voice and unknown fields", async () => {
    await expect(voicePreviewService.preview(owner, { voice: "  " })).rejects.toThrow();
    await expect(voicePreviewService.preview(owner, { voice: "ritu", text: "say anything" })).rejects.toThrow();
  });
});
