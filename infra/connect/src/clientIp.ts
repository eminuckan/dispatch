// @effect-diagnostics nodeBuiltinImport:off - The standalone Connect HTTP service resolves socket addresses directly.
import * as NodeNet from "node:net";
import type { IncomingMessage } from "node:http";

function normalizedIp(value: string): string | null {
  const trimmed = value.trim();
  const version = NodeNet.isIP(trimmed);
  if (!version) return null;
  if (version === 4) return trimmed;
  let ipv6 = trimmed.toLowerCase();
  const dottedTail = ipv6.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const parts = dottedTail.split(".").map(Number);
    ipv6 =
      ipv6.slice(0, -dottedTail.length) +
      `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = ipv6.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words =
    halves.length > 1
      ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
      : left;
  const numbers = words.map((part) => Number.parseInt(part, 16));
  if (numbers.slice(0, 5).every((part) => part === 0) && numbers[5] === 0xffff) {
    return `${numbers[6]! >> 8}.${numbers[6]! & 255}.${numbers[7]! >> 8}.${numbers[7]! & 255}`;
  }
  return numbers.map((part) => part.toString(16)).join(":");
}

export class ConnectClientIp {
  private readonly proxies = new NodeNet.BlockList();

  constructor(trustedProxyCidrs: readonly string[]) {
    for (const cidr of trustedProxyCidrs) {
      const [rawAddress, rawPrefix, extra] = cidr.split("/");
      const address = normalizedIp(rawAddress ?? "");
      if (!address || extra !== undefined)
        throw new Error("CONNECT_TRUSTED_PROXY_CIDRS contains an invalid CIDR");
      const version = NodeNet.isIP(address);
      const prefix = rawPrefix === undefined ? (version === 4 ? 32 : 128) : Number(rawPrefix);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > (version === 4 ? 32 : 128))
        throw new Error("CONNECT_TRUSTED_PROXY_CIDRS contains an invalid prefix");
      this.proxies.addSubnet(address, prefix, version === 4 ? "ipv4" : "ipv6");
    }
  }

  resolve(request: {
    readonly headers: IncomingMessage["headers"];
    readonly socket: { readonly remoteAddress?: string | undefined };
  }): string {
    const remote = normalizedIp(request.socket.remoteAddress ?? "");
    if (!remote) return "unknown";
    let current = remote;
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length <= 2048) {
      const addresses = forwarded.split(",").map(normalizedIp);
      if (addresses.every((address) => address !== null)) {
        for (let index = addresses.length - 1; index >= 0; index--) {
          if (!this.proxies.check(current, NodeNet.isIP(current) === 4 ? "ipv4" : "ipv6")) break;
          current = addresses[index]!;
        }
      }
    }
    return current;
  }

  bucket(address: string): string {
    const normalized = normalizedIp(address);
    if (!normalized) return "unknown";
    // One IPv6 subscriber cannot multiply its quota by rotating addresses within its /64.
    return NodeNet.isIP(normalized) === 6
      ? `${normalized.split(":").slice(0, 4).join(":")}::/64`
      : normalized;
  }
}
