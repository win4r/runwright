/**
 * Address classification for the SSRF guard. Parses IPv4 and IPv6 text itself (no DNS) and sorts an address into
 * a class; only "public" may be connected to.
 *
 * Blocked ranges:
 * - metadata: 169.254.169.254, 100.100.100.200, fd00:ec2::254 (checked before the wider classes)
 * - unspecified: 0.0.0.0/8, ::
 * - loopback: 127.0.0.0/8, ::1
 * - private: 10/8, 172.16/12, 192.168/16, fc00::/7, fec0::/10 (deprecated site-local)
 * - link_local: 169.254/16, fe80::/10
 * - cgnat: 100.64/10
 * - multicast: 224/4, ff00::/8
 * - reserved: 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 240/4
 *   (including 255.255.255.255); 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64), 100::/64 (discard), 2001::/23 (IETF
 *   protocol assignments, including Teredo and ORCHID), 2001:db8::/32 and 3fff::/20 (documentation), 2002::/16
 *   (6to4), 5f00::/16 (SRv6), and every IPv6 address outside 2000::/3 global unicast that is not listed above.
 * IPv4-mapped (::ffff:a.b.c.d, also written in hex), IPv4-translated (::ffff:0:a.b.c.d) and IPv4-compatible
 * (::a.b.c.d) IPv6 addresses are classified by their embedded IPv4 address. Text that is not an IP address is
 * "reserved".
 */
export type AddressClass = "public" | "loopback" | "private" | "link_local" | "cgnat" | "metadata" | "unspecified" | "multicast" | "reserved";

/** Strict dotted-decimal IPv4 (four parts, 0..255, no leading zeros) → 4 bytes, else null. */
function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** IPv6 text (optionally bracketed, optionally with a zone id, optionally ending in dotted IPv4) → 16 bytes, else null. */
function parseIPv6(input: string): number[] | null {
  let text = input;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone >= 0) {
    if (zone === text.length - 1) return null;
    text = text.slice(0, zone);
  }
  if (!text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string, allowTrailingV4: boolean): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] as string;
      if (allowTrailingV4 && index === groups.length - 1 && group.includes(".")) {
        const v4 = parseIPv4(group);
        if (v4 === null) return null;
        out.push((v4[0] as number) * 256 + (v4[1] as number), (v4[2] as number) * 256 + (v4[3] as number));
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
        out.push(parseInt(group, 16));
      }
    }
    return out;
  };
  let words: number[];
  if (halves.length === 2) {
    const head = parseGroups(halves[0] as string, false);
    const tail = parseGroups(halves[1] as string, true);
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    words = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    const all = parseGroups(text, true);
    if (all === null || all.length !== 8) return null;
    words = all;
  }
  const bytes: number[] = [];
  for (const word of words) bytes.push(word >> 8, word & 0xff);
  return bytes;
}

function inPrefix(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit += 1) {
    const index = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if (((bytes[index] as number) & mask) !== ((prefix[index] as number) & mask)) return false;
  }
  return true;
}

const V4_RANGES: readonly { prefix: readonly number[]; bits: number; cls: AddressClass }[] = [
  { prefix: [169, 254, 169, 254], bits: 32, cls: "metadata" },
  { prefix: [100, 100, 100, 200], bits: 32, cls: "metadata" },
  { prefix: [0, 0, 0, 0], bits: 8, cls: "unspecified" },
  { prefix: [127, 0, 0, 0], bits: 8, cls: "loopback" },
  { prefix: [10, 0, 0, 0], bits: 8, cls: "private" },
  { prefix: [172, 16, 0, 0], bits: 12, cls: "private" },
  { prefix: [192, 168, 0, 0], bits: 16, cls: "private" },
  { prefix: [169, 254, 0, 0], bits: 16, cls: "link_local" },
  { prefix: [100, 64, 0, 0], bits: 10, cls: "cgnat" },
  { prefix: [224, 0, 0, 0], bits: 4, cls: "multicast" },
  { prefix: [192, 0, 0, 0], bits: 24, cls: "reserved" },
  { prefix: [192, 0, 2, 0], bits: 24, cls: "reserved" },
  { prefix: [192, 88, 99, 0], bits: 24, cls: "reserved" },
  { prefix: [198, 18, 0, 0], bits: 15, cls: "reserved" },
  { prefix: [198, 51, 100, 0], bits: 24, cls: "reserved" },
  { prefix: [203, 0, 113, 0], bits: 24, cls: "reserved" },
  { prefix: [240, 0, 0, 0], bits: 4, cls: "reserved" },
];

function v6(text: string): number[] {
  const bytes = parseIPv6(text);
  if (bytes === null) throw new Error(`bad built-in IPv6 prefix ${text}`);
  return bytes;
}

const V6_RANGES: readonly { prefix: readonly number[]; bits: number; cls: AddressClass }[] = [
  { prefix: v6("fd00:ec2::254"), bits: 128, cls: "metadata" },
  { prefix: v6("::"), bits: 128, cls: "unspecified" },
  { prefix: v6("::1"), bits: 128, cls: "loopback" },
  { prefix: v6("fc00::"), bits: 7, cls: "private" },
  { prefix: v6("fec0::"), bits: 10, cls: "private" },
  { prefix: v6("fe80::"), bits: 10, cls: "link_local" },
  { prefix: v6("ff00::"), bits: 8, cls: "multicast" },
  { prefix: v6("64:ff9b::"), bits: 96, cls: "reserved" },
  { prefix: v6("64:ff9b:1::"), bits: 48, cls: "reserved" },
  { prefix: v6("100::"), bits: 64, cls: "reserved" },
  { prefix: v6("2001::"), bits: 23, cls: "reserved" },
  { prefix: v6("2001:db8::"), bits: 32, cls: "reserved" },
  { prefix: v6("2002::"), bits: 16, cls: "reserved" },
  { prefix: v6("3fff::"), bits: 20, cls: "reserved" },
  { prefix: v6("5f00::"), bits: 16, cls: "reserved" },
];

const MAPPED = v6("::ffff:0:0");
const TRANSLATED = v6("::ffff:0:0:0");
const COMPATIBLE = v6("::");
const GLOBAL_UNICAST = v6("2000::");

function classifyV4(bytes: readonly number[]): AddressClass {
  for (const range of V4_RANGES) if (inPrefix(bytes, range.prefix, range.bits)) return range.cls;
  return "public";
}

function classifyV6(bytes: readonly number[]): AddressClass {
  if (inPrefix(bytes, MAPPED, 96) || inPrefix(bytes, TRANSLATED, 96)) return classifyV4(bytes.slice(12));
  for (const range of V6_RANGES) if (inPrefix(bytes, range.prefix, range.bits)) return range.cls;
  if (inPrefix(bytes, COMPATIBLE, 96)) return classifyV4(bytes.slice(12));
  if (!inPrefix(bytes, GLOBAL_UNICAST, 3)) return "reserved";
  return "public";
}

/** The class of an IP address given as text. Anything that is not an IPv4 or IPv6 address is "reserved". */
export function classifyAddress(address: string): AddressClass {
  const text = address.trim();
  const v4 = parseIPv4(text);
  if (v4 !== null) return classifyV4(v4);
  const v6bytes = parseIPv6(text);
  if (v6bytes !== null) return classifyV6(v6bytes);
  return "reserved";
}

/** True for every class except "public". */
export function isBlockedAddress(address: string): boolean {
  return classifyAddress(address) !== "public";
}
