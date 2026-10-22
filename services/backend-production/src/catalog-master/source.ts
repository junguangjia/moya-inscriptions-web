import path from "node:path";

import {
  LocalCatalogSourceReader,
  openCosCatalogSourceReader,
  parseCatalogSourceConfig,
} from "../storage/catalog-source.js";
import { CatalogMasterUsageError } from "./commands.js";

import type { CatalogSourceReader } from "../storage/catalog-source.js";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The media worker's Catalog source reader for `--from-source`, opened as the
 * worker opens it (catalog-deep-zoom-self-master-v1): the
 * `CATALOG_SOURCE_COS_*` identity whenever any of that namespace is set (a
 * partial or malformed one fails, naming the setting and never its value),
 * else in Development only the local Payload media directory. No other
 * identity; no cloud request is made here.
 */
export const openCatalogMasterSource = async (
  environment: Environment,
): Promise<CatalogSourceReader> => {
  const config = parseCatalogSourceConfig(environment);
  if (config !== null) return openCosCatalogSourceReader(config);
  if (environment.NODE_ENV === "development" && environment.CMS_MEDIA_DIR)
    return new LocalCatalogSourceReader(
      path.resolve(environment.CMS_MEDIA_DIR),
    );
  throw new CatalogMasterUsageError(
    environment.NODE_ENV === "development"
      ? "--from-source needs CATALOG_SOURCE_COS_* or CMS_MEDIA_DIR"
      : "--from-source needs CATALOG_SOURCE_COS_*",
  );
};
