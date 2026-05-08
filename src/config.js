import { z } from 'zod';

const Schema = z.object({
  PORT: z.coerce.number().int().positive().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE: z.string().min(1).default('mongodb://localhost:27017'),
  DATABASE_NAME: z.string().min(1).default('flaiDB'),
  PASS: z.string().min(1, 'PASS env var is required'),
  ALLOWED_ORIGINS: z
    .string()
    .default('https://jvoltci.github.io,https://flai.ivehement.com,http://localhost:3000,http://localhost:5173')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
  PUBLIC_URL: z.string().url().optional(),
  KEEP_WARM_INTERVAL_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  TORRENT_IDLE_EVICT_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  MAX_ACTIVE_TORRENTS: z.coerce.number().int().positive().default(8),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
