import { secureServiceUrl } from "@flies/sync";
import * as v from "valibot";
export const configSchema = v.object({
  SYNC_SERVER_URL: v.optional(v.string()),
  SYNC_SERVER_SECRET: v.optional(v.string()),
  DATABASE_URL: v.pipe(v.string(), v.url()),
  WORKOS_API_KEY: v.pipe(v.string(), v.minLength(1)),
  WORKOS_CLIENT_ID: v.pipe(v.string(), v.minLength(1)),
  WORKOS_COOKIE_PASSWORD: v.pipe(v.string(), v.minLength(32)),
  WORKOS_REDIRECT_URI: v.pipe(v.string(), v.url()),
  WEB_URL: v.pipe(v.string(), v.url()),
  API_URL: v.pipe(v.string(), v.url()),
  PORT: v.optional(
    v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1), v.maxValue(65535)),
    "3001",
  ),
  S3_ENDPOINT: v.pipe(v.string(), v.url()),
  S3_BUCKET: v.pipe(v.string(), v.minLength(1)),
  S3_REGION: v.pipe(v.string(), v.minLength(1)),
  S3_ACCESS_KEY_ID: v.pipe(v.string(), v.minLength(1)),
  S3_SECRET_ACCESS_KEY: v.pipe(v.string(), v.minLength(1)),
  S3_PREFIX: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9/_-]+$/)), "revisions"),
  POLAR_ACCESS_TOKEN: v.optional(v.string()),
  POLAR_WEBHOOK_SECRET: v.optional(v.string()),
  POLAR_PRO_PRODUCT_ID: v.optional(v.string()),
  POLAR_ORGANIZATION_ID: v.optional(v.string()),
  POLAR_SERVER: v.optional(
    v.pipe(
      v.string(),
      v.transform((value) => value.trim() || undefined),
      v.optional(v.picklist(["production", "sandbox"])),
    ),
  ),
});
export type Config = v.InferOutput<typeof configSchema>;

export function billingConfig(
  config: Pick<
    Config,
    | "POLAR_ACCESS_TOKEN"
    | "POLAR_WEBHOOK_SECRET"
    | "POLAR_PRO_PRODUCT_ID"
    | "POLAR_ORGANIZATION_ID"
    | "POLAR_SERVER"
  >,
) {
  const required = [
    "POLAR_ACCESS_TOKEN",
    "POLAR_WEBHOOK_SECRET",
    "POLAR_PRO_PRODUCT_ID",
    "POLAR_ORGANIZATION_ID",
  ] as const;

  if (![...required, "POLAR_SERVER" as const].some((key) => config[key]?.trim())) return null;
  const missing = required.filter((key) => !config[key]?.trim());
  if (missing.length) throw new Error(`Incomplete Polar configuration: ${missing.join(", ")}`);
  for (const key of ["POLAR_PRO_PRODUCT_ID", "POLAR_ORGANIZATION_ID"] as const)
    if (!v.safeParse(v.pipe(v.string(), v.uuid()), config[key]).success)
      throw new Error(`Invalid Polar configuration: ${key}`);

  return {
    accessToken: config.POLAR_ACCESS_TOKEN!,
    webhookSecret: config.POLAR_WEBHOOK_SECRET!,
    productId: config.POLAR_PRO_PRODUCT_ID!,
    organizationId: config.POLAR_ORGANIZATION_ID!,
    server: config.POLAR_SERVER ?? "production",
  };
}

export function readConfig() {
  const result = v.safeParse(configSchema, process.env);
  if (!result.success)
    throw new Error(
      `Missing or invalid API configuration: ${result.issues.map((issue) => issue.path?.map((part) => part.key).join(".")).join(", ")}`,
    );

  billingConfig(result.output);
  realtimeConfig(result.output);

  return result.output;
}

export function realtimeConfig(
  config: Pick<Config, "SYNC_SERVER_URL" | "SYNC_SERVER_SECRET" | "API_URL">,
) {
  const url = config.SYNC_SERVER_URL?.trim();
  const secret = config.SYNC_SERVER_SECRET?.trim();
  if (!url && !secret) return null;
  if (!url || !secret || secret.length < 32)
    throw new Error(
      "Realtime needs SYNC_SERVER_URL and SYNC_SERVER_SECRET (at least 32 characters).",
    );
  secureServiceUrl(config.API_URL);

  return { url: secureServiceUrl(url), secret };
}
