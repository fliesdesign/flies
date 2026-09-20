import * as v from "valibot";
export const configSchema = v.object({
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
});
export type Config = v.InferOutput<typeof configSchema>;

export function readConfig() {
  const result = v.safeParse(configSchema, process.env);
  if (!result.success)
    throw new Error(
      `Missing or invalid API configuration: ${result.issues.map((issue) => issue.path?.map((part) => part.key).join(".")).join(", ")}`,
    );

  return result.output;
}
