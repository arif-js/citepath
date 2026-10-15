import { z } from 'zod';

/**
 * Configuration file schema. Sources are defined here; the index database stores
 * only index and sync state. JSON Schema for editors is generated from this file
 * into schema/citepath.schema.json (see test/unit/config-schema.test.ts).
 */

export const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const sourceId = z
  .string()
  .regex(
    SOURCE_ID_PATTERN,
    'must be 1-63 lowercase letters, digits, "-" or "_", starting with a letter or digit'
  );

const globList = z.array(z.string().min(1)).optional();
const threshold = z.number().gt(0).lte(1).optional();

const httpUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an absolute http(s) URL');

export const WebSourceSchema = z.strictObject({
  id: sourceId,
  type: z.literal('web'),
  name: z.string().min(1).optional(),
  url: httpUrl.describe('Start URL. Its directory path is the default crawl scope.'),
  path_prefix: z
    .string()
    .startsWith('/')
    .optional()
    .describe('Crawl scope path prefix. Defaults to the directory of `url`.'),
  sitemap_urls: z.array(httpUrl).optional().describe('Sitemaps to use instead of auto-discovery.'),
  discovery: z
    .enum(['auto', 'sitemap', 'crawl'])
    .optional()
    .describe('auto: sitemap if one is found, else follow links.'),
  include: globList.describe('URL path globs to include, e.g. "/docs/**".'),
  exclude: globList.describe('URL path globs to exclude.'),
  content_selector: z.string().min(1).optional().describe('CSS selector for the main content region.'),
  query_params: z
    .enum(['drop', 'keep'])
    .optional()
    .describe('How to treat URL query strings. Default: drop.'),
  max_pages: z.number().int().positive().optional(),
  max_depth: z.number().int().nonnegative().optional(),
  max_response_bytes: z.number().int().positive().optional(),
  timeout_ms: z.number().int().positive().optional(),
  max_redirects: z.number().int().nonnegative().max(20).optional(),
  concurrency: z.number().int().positive().max(16).optional(),
  requests_per_second: z.number().positive().max(50).optional(),
  allow_private_network: z
    .boolean()
    .optional()
    .describe('Allow private, loopback, and link-local addresses (e.g. an intranet docs site).'),
  mass_delete_threshold: threshold,
});

export const LocalSourceSchema = z.strictObject({
  id: sourceId,
  type: z.literal('local'),
  name: z.string().min(1).optional(),
  path: z.string().min(1).describe('Directory to index. Relative paths resolve from the config file.'),
  include: globList.describe('File globs relative to the source root.'),
  exclude: globList.describe('File globs to exclude.'),
  base_url: httpUrl.optional().describe('Public URL that corresponds to the source root.'),
  url_style: z
    .enum(['repository', 'site'])
    .optional()
    .describe('repository: <base>/<path>#L10-L20; site: <base>/<path without extension>#<slug>.'),
  max_file_bytes: z.number().int().positive().optional(),
  mass_delete_threshold: threshold,
});

export const SourceConfigSchema = z.discriminatedUnion('type', [WebSourceSchema, LocalSourceSchema]);

export const ConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    data_dir: z
      .string()
      .min(1)
      .optional()
      .describe('Index location. Overridden by --data-dir and CITEPATH_DATA_DIR.'),
    mass_delete_threshold: threshold.describe('Default share of a source that one sync may remove (0-1].'),
    sources: z.array(SourceConfigSchema).default([]),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.sources.forEach((source, index) => {
      if (seen.has(source.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources', index, 'id'],
          message: `duplicate source id "${source.id}"`,
        });
      }
      seen.add(source.id);
    });
  });

export type WebSourceConfig = z.infer<typeof WebSourceSchema>;
export type LocalSourceConfig = z.infer<typeof LocalSourceSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type CitepathConfig = z.infer<typeof ConfigSchema>;

export function buildJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>;
}
