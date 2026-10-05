import { getConfig } from "../../config/env.js";
import { ExotelProvider } from "./exotel.provider.js";
import { MockTelephonyProvider } from "./mock.provider.js";
import type { ITelephonyProvider } from "./telephony.interface.js";

export type { ITelephonyProvider } from "./telephony.interface.js";

let cached: ITelephonyProvider | null = null;

/**
 * Returns the configured telephony provider. Selection is explicit via
 * TELEPHONY_PROVIDER ("mock" | "exotel") — never silently switched at
 * runtime. A real call attempted against the mock provider is simply
 * not possible: the provider in use is fixed at process start.
 */
export function getTelephonyProvider(): ITelephonyProvider {
  if (cached) return cached;
  const { telephonyProvider } = getConfig();
  cached = telephonyProvider === "exotel" ? new ExotelProvider() : new MockTelephonyProvider();
  return cached;
}
