/**
 * Prints the WebSocket URL to paste into the "Voicebot" applet of your Exotel App Bazaar flow
 * (Greeting -> Voicebot), and the checklist around it.
 *
 *   pnpm exotel:flow-url            token masked (safe to screenshot or paste into chat)
 *   pnpm exotel:flow-url --reveal   prints the real URL, token included: run it only on your own screen
 *
 * The URL is built from EXOTEL_WEBHOOK_BASE_URL (must be a stable https:// address, e.g. your ngrok static domain)
 * and EXOTEL_AGENTSTREAM_WEBHOOK_SECRET. The token is what authenticates Exotel's connection; never share it.
 */
import { loadEnv } from "../config/env.js";
loadEnv();
import { getConfig } from "../config/env.js";

const reveal = process.argv.includes("--reveal");
const { exotel } = getConfig();

const problems: string[] = [];
if (!/^https:\/\//i.test(exotel.webhookBaseUrl)) {
  problems.push("EXOTEL_WEBHOOK_BASE_URL must be set and start with https:// (a stable public address).");
}
if (!exotel.agentStreamWebhookSecret) {
  problems.push("EXOTEL_AGENTSTREAM_WEBHOOK_SECRET is not set (it authenticates Exotel's WebSocket connection).");
}
if (problems.length > 0) {
  console.error("Cannot build the Voicebot applet URL:");
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}

const base = exotel.webhookBaseUrl.replace(/\/+$/, "").replace(/^https/i, "wss");
const token = reveal ? encodeURIComponent(exotel.agentStreamWebhookSecret) : "<secret hidden>";
const url = `${base}/api/telephony/exotel/media-stream?token=${token}`;

console.log("Voicebot applet WebSocket URL:");
console.log(`  ${url}`);
if (!reveal) console.log("  (token masked; run `pnpm exotel:flow-url --reveal` locally to print the real URL)");
console.log(`
Setup checklist (Exotel dashboard, after Exotel has enabled the Voicebot applet):
  1. App Bazaar -> create a new flow.
  2. Drag in the Greeting applet, then the Voicebot applet; paste the URL above into the Voicebot applet.
  3. Save the flow. Assign it to your SECOND ExoPhone (not the sandbox/trial number).
  4. In this app, link that ExoPhone's number to an agent (Agent -> phone numbers) so inbound calls are routed to it.
  5. For OUTBOUND calls through the same flow, set EXOTEL_FLOW_APP_ID to the flow's App ID (shown in App Bazaar).
Unconfirmed until a real call is made: whether Exotel passes the ?token= query string through to our server.
If it does not, ask Exotel about Basic-auth or IP-whitelisting for the Voicebot applet.`);
