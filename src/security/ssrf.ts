import { lookup } from "dns/promises";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";
import { env } from "../config/env";

export class InvalidDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDestinationError";
  }
}

const HTTP_URL = /^https?:\/\//i;

function isIpV6WithZone(hostname: string): boolean {
  return hostname.includes("%");
}

/**
 * Basic SSRF guard (spec 4.9) - NOT complete SSRF protection.
 *
 * Production:
 *  - http/https only
 *  - block localhost, loopback, private IPv4 ranges, IPv6 loopback/private,
 *    link-local, unspecified
 *  - resolve DNS and reject if ANY resolved address is prohibited
 *  - redirects are never followed (axios maxRedirects: 0)
 *
 * Development:
 *  - hosts listed in DEV_ALLOWED_LOCAL_HOSTS (default: localhost, 127.0.0.1)
 *    are allowed so the local mock receivers can be used
 *
 * Known limitations (documented, not "complete" SSRF protection):
 *  - no DNS-rebinding protection (TOCTOU between this check and the HTTP
 *    request: a hostile DNS server can return a public IP here and a private
 *    IP a moment later)
 *  - no redirect-chain validation (redirects are disabled, so a 3xx is a
 *    non-retryable failure instead)
 *  - no port allow-list (any port on an allowed host is reachable)
 */
export async function assertSafeDestination(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidDestinationError("destinationUrl is not a valid URL");
  }

  if (!HTTP_URL.test(rawUrl) || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new InvalidDestinationError("only http and https protocols are allowed");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.length === 0) {
    throw new InvalidDestinationError("destinationUrl has no hostname");
  }
  if (isIpV6WithZone(hostname)) {
    throw new InvalidDestinationError("IPv6 zone identifiers are not allowed");
  }

  // Development-only exception for the local mock receivers.
  if (!env.isProduction && env.devAllowedLocalHosts.includes(hostname)) {
    return;
  }

  // Literal IPs are validated directly; hostnames are resolved.
  let addresses: LookupAddress[];
  if (ipaddr.isValid(hostname)) {
    addresses = [{ address: hostname, family: hostname.includes(":") ? 6 : 4 }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new InvalidDestinationError(`cannot resolve destination hostname: ${hostname}`);
    }
  }

  if (addresses.length === 0) {
    throw new InvalidDestinationError(`destination hostname resolved to no addresses: ${hostname}`);
  }

  for (const { address } of addresses) {
    if (isProhibitedIp(address)) {
      throw new InvalidDestinationError(
        `destination resolves to a prohibited address (${address})`
      );
    }
  }
}

function isProhibitedIp(address: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return true; // unparseable = reject
  }

  if (parsed.kind() === "ipv4") {
    const v4 = parsed as ipaddr.IPv4;
    const range = v4.range();
    if (range !== "unicast") {
      // loopback, private, linkLocal, reserved, broadcast, multicast, carrierGradeNat
      return true;
    }
    return false;
  }

  const v6 = parsed as ipaddr.IPv6;
  const range = v6.range();
  // Allow global unicast; block loopback, linkLocal, uniqueLocal, etc.
  if (range === "6to4" || range === "teredo" || range === "reserved") {
    return true;
  }
  return range !== "unicast";
}

/** Hostname used for the per-hostname token bucket key (spec 4.7). */
export function destinationHostname(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  return parsed.hostname.toLowerCase().replace(/\.$/, "");
}

/** Test basic SSRF policy through an exported range helper. */
export function isProhibitedDestinationIp(address: string): boolean {
  return isProhibitedIp(address);
}
