import * as migration_20260908_030835_p2_04_initial from "./20260908_030835_p2_04_initial";
import * as migration_20260908_031500_published_views from "./20260908_031500_published_views";
import * as migration_20260908_035348_p2_04_identity_claims from "./20260908_035348_p2_04_identity_claims";
import * as migration_20260908_120000_published_search from "./20260908_120000_published_search";
import * as migration_20260913_063830_phase4_discovery_metadata from "./20260913_063830_phase4_discovery_metadata";
import * as migration_20260913_064000_discovery_publication from "./20260913_064000_discovery_publication";
import * as migration_20260917_010000_agent_admin from "./20260917_010000_agent_admin";
import * as migration_20260922_014939_editorial_content from "./20260922_014939_editorial_content";
import * as migration_20260922_015000_editorial_content_views from "./20260922_015000_editorial_content_views";
import * as migration_20260922_021836_editorial_article_approvals from "./20260922_021836_editorial_article_approvals";

export const migrations = [
  {
    up: migration_20260908_030835_p2_04_initial.up,
    down: migration_20260908_030835_p2_04_initial.down,
    name: "20260908_030835_p2_04_initial",
  },
  {
    up: migration_20260908_031500_published_views.up,
    down: migration_20260908_031500_published_views.down,
    name: "20260908_031500_published_views",
  },
  {
    up: migration_20260908_035348_p2_04_identity_claims.up,
    down: migration_20260908_035348_p2_04_identity_claims.down,
    name: "20260908_035348_p2_04_identity_claims",
  },
  {
    up: migration_20260908_120000_published_search.up,
    down: migration_20260908_120000_published_search.down,
    name: "20260908_120000_published_search",
  },
  {
    up: migration_20260913_063830_phase4_discovery_metadata.up,
    down: migration_20260913_063830_phase4_discovery_metadata.down,
    name: "20260913_063830_phase4_discovery_metadata",
  },
  {
    up: migration_20260913_064000_discovery_publication.up,
    down: migration_20260913_064000_discovery_publication.down,
    name: "20260913_064000_discovery_publication",
  },
  {
    up: migration_20260917_010000_agent_admin.up,
    down: migration_20260917_010000_agent_admin.down,
    name: "20260917_010000_agent_admin",
  },
  {
    up: migration_20260922_014939_editorial_content.up,
    down: migration_20260922_014939_editorial_content.down,
    name: "20260922_014939_editorial_content",
  },
  {
    up: migration_20260922_015000_editorial_content_views.up,
    down: migration_20260922_015000_editorial_content_views.down,
    name: "20260922_015000_editorial_content_views",
  },
  {
    up: migration_20260922_021836_editorial_article_approvals.up,
    down: migration_20260922_021836_editorial_article_approvals.down,
    name: "20260922_021836_editorial_article_approvals",
  },
];
