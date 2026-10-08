/** Public read DTO delivery is a complete-group operation; byte and authoring ports are unchanged. */
import { validatePublishedKey } from "./keys.js";
export interface PublicationDeliveryOptions {
  readonly enabled: () => boolean;
  readonly origin?: string;
  readonly lookup: (
    itemIds: readonly string[],
    now: Date,
  ) => Promise<ReadonlyMap<string, string>>;
}

const relay =
  /^\/api\/community\/publishing\/media\/(media-item-[0-9a-f]{32})\/(thumb|cover|display|viewer|full|motion)\/(base|[0-9a-f]{32})$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A missing or withdrawn member keeps both the parent and every candidate on the relay. */
export const mapPublishedMedia = async <T>(
  value: T,
  options: PublicationDeliveryOptions,
): Promise<T> => {
  if (!options.enabled() || options.origin === undefined) return value;
  const ids = new Set<string>();
  const collect = (entry: unknown): void => {
    if (typeof entry === "string") {
      const match = relay.exec(entry);
      if (match) ids.add(match[1]!);
    } else if (Array.isArray(entry)) entry.forEach(collect);
    else if (isRecord(entry)) Object.values(entry).forEach(collect);
  };
  collect(value);
  if (ids.size === 0) return value;
  const keys = await options.lookup([...ids], new Date());
  if (!options.enabled()) return value;
  const url = (src: unknown): string | undefined => {
    if (typeof src !== "string" || !relay.test(src)) return undefined;
    const key = keys.get(src);
    if (key === undefined) return undefined;
    try {
      validatePublishedKey(key);
    } catch {
      return undefined;
    }
    return `${options.origin}/${key}`;
  };
  const map = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(map);
    if (!isRecord(entry)) return entry;
    const result: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(entry))
      result[name] =
        name === "renditions" || name === "coverRenditions"
          ? child
          : map(child);
    const group = (
      anchor: "src" | "coverSrc",
      candidates: "renditions" | "coverRenditions",
      motion?: "motionSrc",
    ) => {
      if (typeof entry[anchor] !== "string" || !relay.test(entry[anchor]))
        return;
      const members: unknown[] = [entry[anchor]];
      if (motion && typeof entry[motion] === "string")
        members.push(entry[motion]);
      const list = entry[candidates];
      if (
        list !== undefined &&
        (!Array.isArray(list) ||
          list.some((row) => !isRecord(row) || typeof row.src !== "string"))
      )
        return;
      if (Array.isArray(list))
        members.push(
          ...list.map((row) => (row as Record<string, unknown>).src),
        );
      if (members.some((src) => url(src) === undefined)) return;
      result[anchor] = url(entry[anchor]);
      if (motion && typeof entry[motion] === "string")
        result[motion] = url(entry[motion]);
      if (Array.isArray(list))
        result[candidates] = list.map((row) => ({
          ...(row as Record<string, unknown>),
          src: url((row as Record<string, unknown>).src),
        }));
    };
    // Candidate entries have no id; only their owning media object may switch them.
    if (typeof entry.id === "string" || Array.isArray(entry.renditions))
      group("src", "renditions", "motionSrc");
    group("coverSrc", "coverRenditions");
    return result;
  };
  return map(value) as T;
};

/** Decorate only explicitly named public read methods. Writes and byte streams keep their original receiver. */
export const withPublishedReads = <T extends object>(
  port: T,
  methods: readonly string[],
  options: PublicationDeliveryOptions,
): T => {
  const selected = new Set(methods);
  return new Proxy(port, {
    get(target, name) {
      const member: unknown = Reflect.get(target, name, target);
      if (typeof member !== "function") return member;
      if (typeof name !== "string" || !selected.has(name))
        return member.bind(target);
      return async (...args: unknown[]) =>
        mapPublishedMedia(await member.apply(target, args), options);
    },
  });
};
