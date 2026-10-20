// Public-input-only build tool. Does not read environment configuration or credentials.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
const { values } = parseArgs({
  options: {
    database: { type: "string" },
    "output-dir": { type: "string" },
    help: { type: "boolean" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Usage: node generate-chinese-dictionaries.mjs --database GeoLite2-City.mmdb --output-dir output",
  );
  process.exit(0);
}
if (!values.database || !values["output-dir"]) {
  console.error("DATABASE_AND_OUTPUT_DIR_REQUIRED");
  process.exit(1);
}
const database = resolve(values.database),
  directory = resolve(values["output-dir"]);
const expected =
  "fd112e5b13ca19e8bb0bf2e1902fb0694f6ba1940bef916e0d8d9d9346f4e029";
const started = Date.now();
let stage = "public-mmdb";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasHan = (value) =>
  typeof value === "string" &&
  /\p{Script=Han}/u.test(value) &&
  !/\p{Script=Latin}/u.test(value);
try {
  const buf = await readFile(database);
  if (buf.length !== 50901339 || sha(buf) !== expected)
    throw new Error("PUBLIC_MMDB_PIN_MISMATCH");
  const marker = buf.lastIndexOf(
    Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com")]),
  );
  if (marker < 0) throw new Error("MMDB_METADATA_MARKER_MISSING");
  let pointerOrigin = marker + 14;
  const cache = new Map();
  let decodedValues = 0,
    cacheHits = 0;
  const decode = (at, depth = 0, budget = { values: 0 }) => {
    if (depth > 128 || ++budget.values > 65536 || at < 0 || at >= buf.length)
      throw new Error("MMDB_DECODE_BOUNDARY");
    decodedValues++;
    let p = at;
    const ctrl = buf[p++];
    let type = ctrl >>> 5,
      size = ctrl & 31;
    if (type === 1) {
      const length = ((ctrl >>> 3) & 3) + 1;
      let offset = buf.readUIntBE(p, length);
      if (length < 4)
        offset += (ctrl & 7) * 2 ** (8 * length) + [0, 0, 2048, 526336][length];
      const target = pointerOrigin + offset;
      if (target < 0 || target >= buf.length)
        throw new Error("MMDB_POINTER_BOUNDARY");
      let value;
      if (cache.has(target)) {
        value = cache.get(target);
        cacheHits++;
      } else {
        value = decode(target, depth + 1, budget)[0];
        if (cache.size >= 100000) cache.delete(cache.keys().next().value);
        cache.set(target, value);
      }
      return [value, p + length];
    }
    if (type === 0) type = buf[p++] + 7;
    if (size >= 29) {
      const length = size - 28;
      size = [29, 285, 65821][length - 1] + buf.readUIntBE(p, length);
      p += length;
    }
    if (size > 1048576 || p + size > buf.length)
      throw new Error("MMDB_VALUE_BOUNDARY");
    if (type === 7) {
      const value = {};
      for (let i = 0; i < size; i++) {
        const key = decode(p, depth + 1, budget);
        p = key[1];
        const entry = decode(p, depth + 1, budget);
        p = entry[1];
        value[key[0]] = entry[0];
      }
      return [value, p];
    }
    if (type === 11) {
      const value = [];
      for (let i = 0; i < size; i++) {
        const item = decode(p, depth + 1, budget);
        value.push(item[0]);
        p = item[1];
      }
      return [value, p];
    }
    if (type === 14) return [Boolean(size), p];
    const end = p + size;
    if (type === 2) return [buf.toString("utf8", p, end), end];
    if (type === 3) return [buf.readDoubleBE(p), end];
    if (type === 15) return [buf.readFloatBE(p), end];
    if (type === 4) return [buf.subarray(p, end), end];
    if ([5, 6, 8, 9, 10].includes(type)) {
      let n = 0n;
      for (let i = p; i < end; i++) n = (n << 8n) | BigInt(buf[i]);
      if (type === 8 && size === 4 && n >= 0x80000000n) n -= 0x100000000n;
      return [
        n <= BigInt(Number.MAX_SAFE_INTEGER) &&
        n >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(n)
          : n,
        end,
      ];
    }
    throw new Error("MMDB_TYPE_UNSUPPORTED");
  };
  const metadata = decode(marker + 14)[0];
  cache.clear();
  if (
    metadata.record_size !== 28 ||
    metadata.ip_version !== 6 ||
    metadata.node_count !== 4228139 ||
    metadata.build_epoch !== 1792177116 ||
    metadata.database_type !== "GeoLite2-City"
  )
    throw new Error("MMDB_METADATA_PIN_MISMATCH");
  const count = metadata.node_count;
  const treeBytes = count * 7;
  pointerOrigin = treeBytes + 16;
  const children = (node) => {
    const at = node * 7,
      mid = buf[at + 3];
    return [
      (mid >>> 4) * 2 ** 24 + buf.readUIntBE(at, 3),
      (mid & 15) * 2 ** 24 + buf.readUIntBE(at + 4, 3),
    ];
  };
  stage = "all-reachable-unique-tree-data-records";
  const leaves = new Set(),
    visited = new Uint8Array(count),
    pending = [0];
  let reachableNodeCount = 0;
  while (pending.length) {
    const node = pending.pop();
    if (visited[node]) continue;
    visited[node] = 1;
    reachableNodeCount++;
    for (const child of children(node)) {
      if (child < count) pending.push(child);
      else if (child > count) {
        const offset = treeBytes + child - count;
        if (offset < pointerOrigin || offset >= marker)
          throw new Error("MMDB_TREE_DATA_POINTER_INVALID");
        leaves.add(offset);
      }
    }
  }
  const cities = new Map(),
    globalCities = new Map(),
    regions = new Map();
  let recordCount = 0,
    recordsWithCityEn = 0,
    recordsWithCityZh = 0,
    rejectedNonHanValues = 0;
  const add = (map, key, rawZh, geo, region) => {
    const zh = hasHan(rawZh) ? rawZh : undefined;
    if (rawZh && !zh) rejectedNonHanValues++;
    let item = map.get(key);
    if (!item) {
      item = {
        translations: new Map(),
        geoIds: new Set(),
        untranslatedGeoIds: new Set(),
        untranslatedWithoutGeoId: false,
      };
      map.set(key, item);
    }
    if (geo !== undefined) item.geoIds.add(String(geo));
    if (!zh) {
      if (geo !== undefined) item.untranslatedGeoIds.add(String(geo));
      else item.untranslatedWithoutGeoId = true;
      return;
    }
    let variant = item.translations.get(zh);
    if (!variant) {
      variant = { regions: new Set(), geoIds: new Set() };
      item.translations.set(zh, variant);
    }
    if (region) variant.regions.add(region);
    if (geo !== undefined) variant.geoIds.add(String(geo));
  };
  for (const offset of leaves) {
    const record = decode(offset)[0];
    if (!record || Array.isArray(record) || typeof record !== "object")
      throw new Error("MMDB_RECORD_NOT_MAP");
    recordCount++;
    const country = record.country?.iso_code;
    const subdivision = record.subdivisions?.[0];
    const code =
      country && subdivision?.iso_code
        ? `${country}-${subdivision.iso_code}`
        : undefined;
    if (code)
      add(
        regions,
        code,
        subdivision.names?.["zh-CN"],
        subdivision.geoname_id,
        code,
      );
    const city = record.city;
    if (city?.names?.en) {
      recordsWithCityEn++;
      if (hasHan(city.names["zh-CN"])) recordsWithCityZh++;
      add(
        globalCities,
        city.names.en,
        city.names["zh-CN"],
        city.geoname_id,
        code ?? country,
      );
      if (country)
        add(
          cities,
          `${country}|${city.names.en}`,
          city.names["zh-CN"],
          city.geoname_id,
          code,
        );
    }
  }
  const dictionary = (map) => {
    const result = {},
      ambiguous = [],
      incomplete = [];
    for (const [key, item] of [...map].sort(([a], [b]) => compare(a, b))) {
      const translatedGeoIds = new Set(
        [...item.translations.values()].flatMap((variant) => [
          ...variant.geoIds,
        ]),
      );
      const unresolvedIds = [...item.untranslatedGeoIds]
        .filter((id) => !translatedGeoIds.has(id))
        .sort(compare);
      const partial =
        item.translations.size > 0 &&
        (unresolvedIds.length > 0 || item.untranslatedWithoutGeoId);
      if (item.translations.size === 1 && !partial) {
        const [zh] = item.translations.keys();
        result[key] = zh;
      } else if (item.translations.size > 1)
        ambiguous.push({
          key,
          variants: [...item.translations]
            .sort(([a], [b]) => compare(a, b))
            .map(([name, variant]) => ({
              name,
              regions: [...variant.regions].sort(compare),
              geonameIds: [...variant.geoIds].sort(compare),
            })),
        });
      if (partial)
        incomplete.push({
          key,
          untranslatedGeonameIds: unresolvedIds,
          untranslatedWithoutGeonameId: item.untranslatedWithoutGeoId,
        });
    }
    return { result, ambiguous, incomplete };
  };
  const city = dictionary(cities),
    globalCity = dictionary(globalCities),
    region = dictionary(regions);
  const lookup = (ip) => {
    let bits;
    if (isIP(ip) === 4)
      bits = ip.split(".").reduce((n, part) => (n << 8n) | BigInt(part), 0n);
    else if (isIP(ip) === 6) {
      const [left, right] = ip.split("::");
      const a = left ? left.split(":") : [],
        b = right ? right.split(":") : [];
      const groups =
        right === undefined
          ? a
          : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
      bits = groups.reduce(
        (n, part) => (n << 16n) | BigInt(`0x${part || "0"}`),
        0n,
      );
    } else throw new Error("FIXTURE_IP_INVALID");
    let node = 0;
    for (let bit = 127; bit >= 0 && node < count; bit--)
      node = children(node)[Number((bits >> BigInt(bit)) & 1n)];
    if (node === count) return null;
    if (node < count) throw new Error("FIXTURE_LOOKUP_INCOMPLETE");
    const r = decode(treeBytes + node - count)[0];
    const c = r.country?.iso_code,
      s = r.subdivisions?.[0];
    return {
      fixtureIp: ip,
      country: c ?? null,
      region: s?.iso_code ? `${c}-${s.iso_code}` : null,
      city: r.city?.names?.en ?? null,
      cityZh: r.city?.names?.["zh-CN"] ?? null,
      regionZh: s?.names?.["zh-CN"] ?? null,
    };
  };
  const fixtures = [
    "223.5.5.5",
    "1.12.12.12",
    "114.114.114.114",
    "140.112.2.2",
    "140.113.1.1",
    "168.95.1.1",
    "2400:3200::1",
  ].map(lookup);
  if (
    fixtures[0]?.city !== "Hangzhou" ||
    fixtures[0]?.cityZh !== "杭州" ||
    fixtures[1]?.city !== "Guangzhou" ||
    fixtures[2]?.city !== null ||
    fixtures[3]?.country !== "TW" ||
    fixtures[5]?.country !== "TW"
  )
    throw new Error("CHINESE_DICTIONARY_FIXTURE_MISMATCH");
  const cityText = JSON.stringify(city.result) + "\n",
    globalCityText = JSON.stringify(globalCity.result) + "\n",
    regionText = JSON.stringify(region.result) + "\n";
  const collisions = {
    city: city.ambiguous,
    globalCity: globalCity.ambiguous,
    region: region.ambiguous,
    partialChineseCoverage: {
      city: city.incomplete,
      globalCity: globalCity.incomplete,
      region: region.incomplete,
    },
    policy:
      "Emit only a single Han-containing, Latin-free zh-CN translation per exact country+English-city, raw English city across ALL countries, or first-subdivision ISO key. Omit conflicting Chinese names and keys with untranslated distinct geoname IDs (or an untranslated record without an ID). Global-city vetoes are computed from all original records, never reconstructed from the country dictionary. Repeated records missing names for an already translated identical geoname ID are safe. Missing and omitted names remain undefined.",
  };
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "geo-city.zh-CN.json"), cityText);
  await writeFile(
    join(directory, "geo-city-global.zh-CN.json"),
    globalCityText,
  );
  await writeFile(join(directory, "geo-region.zh-CN.json"), regionText);
  await writeFile(
    join(directory, "geo-translations-collisions.json"),
    JSON.stringify(collisions, null, 2) + "\n",
  );
  const notice =
    "Chinese display-name dictionaries derived from the pinned GeoLite2-City database.\nThis product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com.\nGeoLite End User License Agreement: https://www.maxmind.com/en/geolite/eula\nCreative Commons Attribution-ShareAlike 4.0: https://creativecommons.org/licenses/by-sa/4.0/\nGeographical names include GeoNames data: https://www.geonames.org/\nGeoNames attribution and license: https://www.geonames.org/export/ (CC BY 4.0: https://creativecommons.org/licenses/by/4.0/)\nChanges: extracted reliable Han-containing zh-CN city and first-subdivision names, grouped by native country/name or ISO code; ambiguous and unresolved names omitted. No raw geolocation records are modified.\nThese dictionaries describe database network geolocation labels; they do not establish an individual visitor's precise location.\n";
  await writeFile(join(directory, "geo-translations-NOTICE.txt"), notice);
  const summary = {
    status: "PASS",
    sourceMmdbSha256: expected,
    sourceBytes: buf.length,
    databaseBuildEpoch: metadata.build_epoch,
    keyFormat: {
      city: "ISO2|city.names.en (exact source spelling)",
      globalCity:
        "city.names.en (exact source spelling, all countries before omission)",
      region: "ISO2-first subdivision iso_code",
    },
    metadata: {
      nodeCount: count,
      reachableNodeCount,
      recordSize: 28,
      ipVersion: 6,
    },
    uniqueDataRecords: recordCount,
    recordsWithCityEn,
    recordsWithCityZh,
    rejectedNonHanValues,
    cityDictionaryEntries: Object.keys(city.result).length,
    globalCityDictionaryEntries: Object.keys(globalCity.result).length,
    regionDictionaryEntries: Object.keys(region.result).length,
    ambiguousCityKeys: city.ambiguous.length,
    ambiguousGlobalCityKeys: globalCity.ambiguous.length,
    ambiguousRegionKeys: region.ambiguous.length,
    partialCoverageCityKeys: city.incomplete.length,
    partialCoverageGlobalCityKeys: globalCity.incomplete.length,
    partialCoverageRegionKeys: region.incomplete.length,
    cityDictionaryBytes: Buffer.byteLength(cityText),
    globalCityDictionaryBytes: Buffer.byteLength(globalCityText),
    regionDictionaryBytes: Buffer.byteLength(regionText),
    cityDictionarySha256: sha(cityText),
    globalCityDictionarySha256: sha(globalCityText),
    regionDictionarySha256: sha(regionText),
    noticeSha256: sha(notice),
    decoder: { pointerCacheLimit: 100000, decodedValues, cacheHits },
    fixtures,
    elapsedMs: Date.now() - started,
    rawMmdbValuesUnchanged: true,
    derivedTaiwanProvinceNotInventedInDictionary: true,
  };
  await writeFile(
    join(directory, "geo-translations-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary));
} catch (error) {
  console.log(
    JSON.stringify({
      status: "FAIL",
      stage,
      category: /^[A-Z0-9_]+$/u.test(error?.message ?? "")
        ? error.message
        : "CHINESE_DICTIONARY_GENERATION_FAILED",
    }),
  );
  process.exitCode = 1;
}
