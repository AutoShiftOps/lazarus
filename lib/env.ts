// lib/env.ts
// Typed environment variable access. Always call getEnv() — never read process.env directly elsewhere.

import { z } from "zod";

const EnvSchema = z.object({
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  /** Dev only; ignored in production. Read via devAllowLoopback(). */
  LAZARUS_DEV_ALLOW_LOOPBACK: z.string().optional(),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("production"),
});

export type Env = z.infer<typeof EnvSchema>;

const DevAllowLoopbackSchema = z
  .string()
  .optional()
  .transform((v) => {
    const s = v?.trim().toLowerCase();
    return s === "1" || s === "true";
  });

/**
 * Dev-only loopback override. Reads only LAZARUS_DEV_ALLOW_LOOPBACK (does not
 * require Upstash variables). Always false in production.
 */
export function devAllowLoopback(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return DevAllowLoopbackSchema.parse(process.env.LAZARUS_DEV_ALLOW_LOOPBACK);
}

const GravewoodHostSchema = z
  .string()
  .optional()
  .transform((v) => {
    const s = v?.trim().toLowerCase();
    return s ? s : undefined;
  });

/**
 * Configured Gravewood demo host, as `host` or `host:port` (LAZARUS_GRAVEWOOD_HOST).
 * Unset or blank means no service is a demo service. Read on every call (not cached).
 */
export function gravewoodHost(): string | undefined {
  return GravewoodHostSchema.parse(process.env.LAZARUS_GRAVEWOOD_HOST);
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

const AnthropicEnvSchema = z.object({
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((v) => {
      const s = v?.trim();
      return s ? s : undefined;
    }),
  ANTHROPIC_MODEL: z
    .string()
    .optional()
    .transform((v) => {
      const s = v?.trim();
      return s ? s : DEFAULT_ANTHROPIC_MODEL;
    }),
});

export type AnthropicEnv = z.output<typeof AnthropicEnvSchema>;

/**
 * Optional Anthropic risk-model settings (does not require Upstash variables).
 * Read on every call. Never log or echo the key.
 */
export function anthropicEnv(): AnthropicEnv {
  return AnthropicEnvSchema.parse({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  });
}

export type SiteEnv = {
  NEXT_PUBLIC_SITE_URL: string | undefined;
  VERCEL_PROJECT_PRODUCTION_URL: string | undefined;
};

/** Site URL variables only (does not require Upstash variables). Read on every call. */
export function siteEnv(): SiteEnv {
  return {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  };
}

export function getEnv(): Env {
  return EnvSchema.parse(process.env);
}
