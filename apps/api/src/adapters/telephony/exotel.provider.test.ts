import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("ExotelProvider status mapping for unanswered calls", () => {
  it.each([
    ["busy", "busy"],
    ["no-answer", "no_answer"],
    ["failed", "failed"],
  ])("maps Exotel %s to %s (not blindly failed)", (exotelStatus, expected) => {
    const parsed = new ExotelProvider().parseStatusCallback({ CallSid: "CA1", Status: exotelStatus });
    expect(parsed.status).toBe(expected);
  });
});

describe("ExotelProvider Connect Voice AI request", () => {
  const ENV = {
    EXOTEL_API_KEY: "test-key",
    EXOTEL_API_TOKEN: "test-token",
    EXOTEL_ACCOUNT_SID: "acme1",
    EXOTEL_SUBDOMAIN: "api.exotel.com",
    EXOTEL_FROM_NUMBER: "0XXXXXXXXXX",
    EXOTEL_WEBHOOK_BASE_URL: "https://abc.ngrok-free.dev/",
    EXOTEL_AGENTSTREAM_WEBHOOK_SECRET: "s3cret",
  };
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    saved.EXOTEL_CALL_TYPE = process.env.EXOTEL_CALL_TYPE;
    delete process.env.EXOTEL_CALL_TYPE;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("puts the customer in From and the ExoPhone in CallerId, with a bidirectional wss StreamUrl", () => {
    const body = new ExotelProvider().buildConnectRequest({ toNumber: "+919000000001", internalCallId: "call-1" });
    expect(body.get("From")).toBe("+919000000001");
    expect(body.get("CallerId")).toBe("0XXXXXXXXXX");
    expect(body.get("To")).toBeNull();
    expect(body.get("StreamType")).toBe("bidirectional");
    expect(body.get("CallType")).toBeNull(); // omitted until Exotel confirms the right value
    const stream = new URL(body.get("StreamUrl")!);
    expect(stream.protocol).toBe("wss:");
    expect(stream.host).toBe("abc.ngrok-free.dev");
    expect(stream.pathname).toBe("/api/telephony/exotel/media-stream");
    expect(stream.searchParams.get("internalCallId")).toBe("call-1");
    expect(stream.searchParams.get("token")).toBe("s3cret");
  });

  it("requests answered + terminal JSON status callbacks on an https URL", () => {
    const body = new ExotelProvider().buildConnectRequest({ toNumber: "+919000000001", internalCallId: "call-1" });
    const cb = new URL(body.get("StatusCallback")!);
    expect(cb.protocol).toBe("https:");
    expect(cb.pathname).toBe("/api/telephony/exotel/status-callback");
    expect(body.get("StatusCallbackEvents[0]")).toBe("terminal");
    expect(body.get("StatusCallbackEvents[1]")).toBe("answered");
    expect(body.get("StatusCallbackContentType")).toBe("application/json");
  });

  it("includes CallType only when EXOTEL_CALL_TYPE is set", () => {
    process.env.EXOTEL_CALL_TYPE = "trans";
    const body = new ExotelProvider().buildConnectRequest({ toNumber: "+919000000001", internalCallId: "c" });
    expect(body.get("CallType")).toBe("trans");
  });

  it("POSTs to the configured region host with Basic auth and returns the Call Sid", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Call: { Sid: "CA999" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ExotelProvider().initiateCall({ toNumber: "+919000000001", internalCallId: "c" });
    expect(result.providerCallId).toBe("CA999");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.exotel.com/v1/Accounts/acme1/Calls/connect.json");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("test-key:test-token").toString("base64")}`);
    vi.unstubAllGlobals();
  });

  it("refuses a non-https webhook base and a missing webhook secret", () => {
    process.env.EXOTEL_WEBHOOK_BASE_URL = "http://abc.ngrok-free.dev";
    expect(() => new ExotelProvider().buildConnectRequest({ toNumber: "+91", internalCallId: "c" })).toThrow(
      ProviderConfigError,
    );
    process.env.EXOTEL_WEBHOOK_BASE_URL = "https://abc.ngrok-free.dev";
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "";
    expect(() => new ExotelProvider().buildConnectRequest({ toNumber: "+91", internalCallId: "c" })).toThrow(
      /EXOTEL_AGENTSTREAM_WEBHOOK_SECRET/,
    );
  });
});

describe("ExotelProvider status callback events", () => {
  it("maps answered/ringing EventType regardless of Status, and terminal events by Status", () => {
    const p = new ExotelProvider();
    expect(p.parseStatusCallback({ CallSid: "CA1", EventType: "answered", Status: "in-progress" }).status).toBe("in_progress");
    expect(p.parseStatusCallback({ CallSid: "CA1", EventType: "ringing" }).status).toBe("ringing");
    const terminal = p.parseStatusCallback({ CallSid: "CA1", EventType: "terminal", Status: "completed", ConversationDuration: "42" });
    expect(terminal.status).toBe("completed");
    expect(terminal.durationSeconds).toBe(42);
  });

  it("rejects an unrecognized status instead of failing a live call", () => {
    expect(() => new ExotelProvider().parseStatusCallback({ CallSid: "CA1", Status: "mystery" })).toThrow(/Unrecognized/);
  });
});
