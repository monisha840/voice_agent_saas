import { describe, it, expect } from "vitest";
import { ExotelProvider } from "./exotel.provider.js";
import { ProviderConfigError } from "../../shared/errors.js";

describe("ExotelProvider (no real credentials configured in this environment)", () => {
  it("initiateCall throws ProviderConfigError with a clear message, never a fake success", async () => {
    const provider = new ExotelProvider();

    await expect(
      provider.initiateCall({ toNumber: "+919999999999", internalCallId: "test-call-id" }),
    ).rejects.toBeInstanceOf(ProviderConfigError);
  });

  it("parseStatusCallback maps a known Exotel status string to our normalized shape", () => {
    const provider = new ExotelProvider();
    const parsed = provider.parseStatusCallback({
      CallSid: "CA123",
      Status: "completed",
      Duration: "154",
    });

    expect(parsed).toEqual({
      providerCallId: "CA123",
      status: "completed",
      durationSeconds: 154,
      recordingUrl: undefined,
    });
  });

  it("parseStatusCallback throws on a payload missing CallSid", () => {
    const provider = new ExotelProvider();
    expect(() => provider.parseStatusCallback({ Status: "completed" })).toThrow();
  });
});
