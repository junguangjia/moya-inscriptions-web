import { isIP } from "node:net";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
export interface IpLocationRange {
  readonly start: string;
  readonly end: string;
  readonly country: string;
  readonly region?: string;
}
interface Range {
  start: bigint;
  end: bigint;
  family: number;
  label: string;
}
const value = (ip: string): { family: number; value: bigint } | null => {
  const family = isIP(ip);
  if (!family) return null;
  if (family === 4)
    return {
      family,
      value: ip.split(".").reduce((acc, p) => acc * 256n + BigInt(p), 0n),
    };
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);
  if (mapped)
    return {
      family: 4,
      value: BigInt(
        `0x${mapped[1]!.padStart(4, "0")}${mapped[2]!.padStart(4, "0")}`,
      ),
    };
  const sides = canonical.split("::");
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  const parts =
    sides.length === 2
      ? [
          ...left,
          ...Array<string>(8 - left.length - right.length).fill("0"),
          ...right,
        ]
      : left;
  return {
    family,
    value: parts.reduce((acc, p) => acc * 65536n + BigInt(`0x${p}`), 0n),
  };
};
export class OfflineIpLocation {
  private readonly ranges: Range[];
  constructor(input: readonly IpLocationRange[]) {
    this.ranges = input
      .map((row) => {
        const start = value(row.start),
          end = value(row.end);
        const mainland = ["CN", "中国", "中国大陆"].includes(row.country);
        const label = mainland ? row.region : row.country;
        if (
          !start ||
          !end ||
          start.family !== end.family ||
          start.value > end.value ||
          !label ||
          label.length > 100 ||
          /[\r\n]/u.test(label) ||
          label.includes("\0")
        )
          throw new Error("REPORT_IP_DATABASE_INVALID");
        return {
          start: start.value,
          end: end.value,
          family: start.family,
          label,
        };
      })
      .sort(
        (a, b) =>
          a.family - b.family ||
          (a.start < b.start ? -1 : a.start > b.start ? 1 : 0),
      );
    for (let i = 1; i < this.ranges.length; i++) {
      const a = this.ranges[i - 1]!,
        b = this.ranges[i]!;
      if (a.family === b.family && b.start <= a.end)
        throw new Error("REPORT_IP_DATABASE_OVERLAP");
    }
  }
  locate(ip: string): string | null {
    const address = value(ip);
    if (!address) return null;
    let low = 0,
      high = this.ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1,
        r = this.ranges[mid]!;
      if (
        address.family < r.family ||
        (address.family === r.family && address.value < r.start)
      )
        high = mid - 1;
      else if (address.family > r.family || address.value > r.end)
        low = mid + 1;
      else return r.label;
    }
    return null;
  }
}
export const loadOfflineIpLocation = async (
  path: string | undefined,
): Promise<OfflineIpLocation | null> => {
  if (!path) return null;
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024)
      throw new Error("REPORT_IP_DATABASE_INVALID");
    const raw = Buffer.alloc(64 * 1024 * 1024 + 1);
    const result = await file.read(raw, 0, raw.length, 0);
    if (result.bytesRead > 64 * 1024 * 1024)
      throw new Error("REPORT_IP_DATABASE_INVALID");
    const parsed: unknown = JSON.parse(
      raw.subarray(0, result.bytesRead).toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null)
      throw new Error("REPORT_IP_DATABASE_INVALID");
    const data = parsed as Record<string, unknown>;
    if (
      data.version !== 1 ||
      typeof data.license !== "string" ||
      !data.license.trim() ||
      !Array.isArray(data.ranges)
    )
      throw new Error("REPORT_IP_DATABASE_INVALID");
    return new OfflineIpLocation(data.ranges as IpLocationRange[]);
  } finally {
    await file.close();
  }
};
