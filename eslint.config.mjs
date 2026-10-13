import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "apps/apple/**",
      "apps/harmony/**",
      "**/.local/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/dist/**",
      "**/node_modules/**",
      "pnpm-lock.yaml",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    files: ["packages/contracts/src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/api",
            "@moya/backend-runtime",
            "@moya/public-api",
            "hono",
            "node-pg-migrate",
            "pg",
          ],
          patterns: [
            {
              group: [
                "@moya/backend-runtime/*",
                "@moya/api/*",
                "@moya/public-api/*",
                "**/apps/**",
                "**/database/**",
                "**/services/**",
              ],
              message:
                "Contracts cannot depend on applications, services, databases, routers, or infrastructure.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/web/**/*.{ts,tsx,mts,cts}",
      "apps/admin/**/*.{ts,tsx,mts,cts}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/api",
            "@moya/backend-runtime",
            "@moya/contracts/json-schema",
            "@moya/contracts/schemas",
            "@moya/public-api",
            "node-pg-migrate",
            "pg",
            "server-only",
          ],
          patterns: [
            {
              group: [
                "@moya/backend-runtime/*",
                "@moya/api/*",
                "@moya/public-api/*",
                "**/data/**",
                "**/database/**",
                "**/infra/**",
                "**/services/**",
                "**/*.csv",
                "**/*.json",
                "**/*.pdf",
                "**/*.tsv",
                "**/*.xls",
                "**/*.xlsx",
              ],
              message:
                "Frontend code cannot access Reader ports, runtime contracts, data files, or server infrastructure.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/lib/public-api/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/api",
            "@moya/backend-runtime",
            "@moya/contracts/json-schema",
            "@moya/public-api",
            "node-pg-migrate",
            "pg",
          ],
          patterns: [
            {
              group: [
                "@moya/backend-runtime/*",
                "@moya/api/*",
                "@moya/public-api/*",
                "@moya/contracts/internal/*",
                "**/data/**",
                "**/database/**",
                "**/infra/**",
                "**/services/**",
                "**/*.csv",
                "**/*.json",
                "**/*.pdf",
                "**/*.tsv",
                "**/*.xls",
                "**/*.xlsx",
              ],
              message:
                "The Web Public API boundary may use public runtime schemas, but not private services, data, or infrastructure.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/ui/src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/api",
            "@moya/backend-runtime",
            "@moya/contracts",
            "@moya/public-api",
            "node-pg-migrate",
            "pg",
          ],
          patterns: [
            {
              group: [
                "@moya/backend-runtime/*",
                "@moya/contracts/*",
                "@moya/api/*",
                "@moya/public-api/*",
                "**/data/**",
                "**/database/**",
                "**/infra/**",
                "**/services/**",
              ],
              message:
                "The shared UI package cannot depend on domain or server layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["services/public-api/src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/api",
            "@moya/backend-runtime",
            "node-pg-migrate",
            "pg",
          ],
          patterns: [
            {
              group: [
                "@moya/api/*",
                "@moya/backend-runtime/*",
                "**/data/**",
                "**/database/**",
              ],
              message:
                "The public API contract package cannot depend on persistence or data files.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["services/backend-runtime/src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/backend-production",
            "@moya/catalog-postgres",
            "@moya/contracts/json-schema",
            "hono",
            "node-pg-migrate",
            "pg",
          ],
          patterns: [
            {
              group: [
                "@moya/api/*",
                "**/apps/**",
                "**/data/**",
                "**/database/**",
                "**/infra/**",
              ],
              message:
                "The HTTP runtime may use only application package roots and runtime contracts, not deep application modules, frontend, data, persistence, or infrastructure implementations.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["services/api/src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "Request",
          message: "Catalog application has no HTTP runtime.",
        },
        {
          name: "Response",
          message: "Catalog application has no HTTP runtime.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/backend-production",
            "@moya/backend-runtime",
            "@moya/catalog-postgres",
            "@moya/public-api",
            "hono",
            "node-pg-migrate",
            "pg",
          ],
          patterns: [
            {
              group: [
                "@moya/backend-runtime/*",
                "@moya/public-api/*",
                "**/apps/**",
                "**/data/**",
                "**/database/**",
                "**/infra/**",
              ],
              message:
                "Catalog application cannot depend on frontend, transport services, data files, persistence, or infrastructure.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["services/api/src/modules/**/application/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/backend-runtime",
            "@moya/public-api",
            "hono",
            "node-pg-migrate",
            "pg",
          ],
          patterns: [
            {
              group: [
                "@moya/backend-runtime/*",
                "@moya/public-api/*",
                "**/apps/**",
                "**/data/**",
                "**/database/**",
                "**/infra/**",
                "**/transport/**",
              ],
              message:
                "Application code cannot depend on transport, frontend, data files, persistence, or infrastructure.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["services/api/src/modules/**/application/**/*.{ts,tsx,mts,cts}"],
    ignores: [
      "services/api/src/modules/**/application/mappers/**/*.{ts,tsx,mts,cts}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/backend-runtime",
            "@moya/public-api",
            "@moya/contracts/json-schema",
            "@moya/contracts/schemas",
            "hono",
            "node-pg-migrate",
            "pg",
          ],
          patterns: [
            {
              group: [
                "@moya/backend-runtime/*",
                "@moya/public-api/*",
                "**/apps/**",
                "**/data/**",
                "**/database/**",
                "**/infra/**",
                "**/transport/**",
              ],
              message:
                "Application code cannot depend on runtime transport contracts, transport modules, data files, persistence, or infrastructure.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["services/catalog-postgres/src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/backend-production",
            "@moya/backend-runtime",
            "@moya/public-api",
          ],
          patterns: [
            {
              group: [
                "@moya/backend-production/*",
                "@moya/backend-runtime/*",
                "@moya/public-api/*",
                "**/apps/**",
                "**/data/**",
              ],
              message:
                "The PostgreSQL adapter cannot depend on transport, frontend, Public API composition, or data files.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["services/backend-production/src/**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@moya/api", "@moya/contracts", "@moya/public-api", "pg"],
          patterns: [
            {
              group: [
                "@moya/api/*",
                "@moya/contracts/*",
                "@moya/public-api/*",
                "**/apps/**",
                "**/data/**",
                "**/database/**",
              ],
              message:
                "The production composition root may depend only on the HTTP runtime and PostgreSQL adapter package roots.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/admin/payload.config.ts",
      "apps/admin/src/editorial/**/*.ts",
      "apps/admin/src/media/**/*.ts",
      "apps/admin/src/migration/**/*.ts",
      "apps/admin/src/preview/**/*.ts",
      "apps/admin/src/published/**/*.ts",
      "apps/admin/src/migrations/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/backend-production",
            "@moya/backend-runtime",
            "@moya/catalog-postgres",
          ],
          patterns: [
            {
              group: [
                "@moya/backend-runtime/*",
                "@moya/backend-production/*",
                "**/data/**",
                "**/*.csv",
                "**/*.xlsx",
              ],
              message:
                "CMS server uses its official adapter and controlled migration input; no unrelated runtime or raw source import.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/admin/src/published/search.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/backend-production",
            "@moya/backend-runtime",
            {
              name: "@moya/catalog-postgres",
              allowImportNames: [
                "catalogSearchSourceSelectSql",
                "projectCatalogSearchSourceRow",
              ],
              message:
                "The CMS publication bridge only shares the existing public Search projection.",
            },
          ],
          patterns: [
            {
              group: [
                "@moya/backend-runtime/*",
                "@moya/backend-production/*",
                "@moya/catalog-postgres/*",
                "**/data/**",
                "**/*.csv",
                "**/*.xlsx",
              ],
              message:
                "CMS server uses its official adapter and controlled migration input; no unrelated runtime or raw source import.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/admin/src/runtime-settings.ts",
      "apps/admin/src/migration/guard.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@moya/backend-production",
            "@moya/backend-runtime",
            "pg",
            {
              name: "@moya/catalog-postgres",
              allowImportNames: [
                "parsePostgresConfig",
                "PostgresConfig",
                "assertMigrationTarget",
                "migrationTargetProbeSql",
              ],
              message:
                "CMS runtime shares only verified connection settings and read-only migration target checks.",
            },
          ],
          patterns: [
            "@moya/catalog-postgres/*",
            "@moya/backend-runtime/*",
            "@moya/backend-production/*",
            "**/data/**",
            "**/*.csv",
            "**/*.xlsx",
          ],
        },
      ],
    },
  },
  {
    // Browser code, workers included (where the installer does not run).
    files: [
      "apps/web/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
      "packages/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}",
    ],
    ignores: [
      "apps/web/lib/platform/abort-signals.ts",
      "apps/web/lib/platform/abort-signals.test.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: [
            "MemberExpression[object.name='AbortSignal'][property.name='any']",
            "MemberExpression[object.name='AbortSignal'][property.value='any']",
            "MemberExpression[object.property.name='AbortSignal'][property.name='any']",
            "VariableDeclarator[init.name='AbortSignal'] > ObjectPattern > Property[key.name='any']",
          ].join(", "),
          message:
            "AbortSignal.any needs Chrome 116, Firefox 124 and Safari 17.4, above the supported browser floors. Use linkAbortSignals from apps/web/lib/platform/abort-signals.ts and dispose() the link when the request finishes.",
        },
      ],
    },
  },
);
