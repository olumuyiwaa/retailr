import { plainToInstance } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength, validateSync } from "class-validator";

export class Env {
  @IsIn(["development", "test", "production"]) NODE_ENV: string = "development";
  @IsInt() @Min(1) @Max(65535) PORT: number = 4000;
  @IsString() @MinLength(1) DATABASE_URL: string;
  @IsString() @MinLength(16, { message: "JWT_ACCESS_SECRET must be at least 16 characters" }) JWT_ACCESS_SECRET: string;
  @IsString() JWT_ACCESS_TTL: string = "15m";
  @IsInt() @Min(1) REFRESH_TOKEN_TTL_DAYS: number = 30;
  @IsString() CORS_ORIGINS: string = "http://localhost:3000";
  /** "local" writes to LOCAL_UPLOAD_DIR and serves /files (dev only); "s3" uses any S3-compatible bucket (S3, R2, Spaces). */
  @IsIn(["local", "s3"]) STORAGE_DRIVER: string = "local";
  /** Public origin of this API, used to build upload and file URLs for the local driver. */
  @IsString() API_PUBLIC_URL: string = "http://localhost:4000";
  /** Where files are publicly readable from (the CDN or bucket URL for s3). Defaults to <API_PUBLIC_URL>/files for local. */
  @IsOptional() @IsString() STORAGE_PUBLIC_URL?: string;
  @IsString() LOCAL_UPLOAD_DIR: string = "./uploads";
  @IsInt() @Min(1024) UPLOAD_MAX_BYTES: number = 2_097_152;
  @IsOptional() @IsString() S3_BUCKET?: string;
  @IsOptional() @IsString() S3_REGION?: string;
  @IsOptional() @IsString() S3_ENDPOINT?: string;
  @IsOptional() @IsString() S3_ACCESS_KEY_ID?: string;
  @IsOptional() @IsString() S3_SECRET_ACCESS_KEY?: string;
  /** "true": a card order counts as paid at once (demo). Leave false until a payment provider is connected. */
  @IsOptional() @IsIn(["true", "false"]) DEMO_CARD_PAYMENTS?: string;
  /** "log" only logs outgoing mail (dev and tests); "smtp" sends through SMTP_URL. */
  @IsIn(["log", "smtp"]) MAIL_DRIVER: string = "log";
  @IsOptional() @IsString() SMTP_URL?: string;
  /** "log" only logs texts (dev and tests); "termii" sends through Termii. */
  @IsIn(["log", "termii"]) SMS_DRIVER: string = "log";
  @IsOptional() @IsString() TERMII_API_KEY?: string;
  @IsOptional() @IsString() TERMII_BASE_URL?: string;
  /** The sender name on texts. In Nigeria it has to be registered with the provider first. */
  @IsString() SMS_SENDER: string = "Retailr";
  @IsOptional() @IsIn(["generic", "dnd"]) TERMII_CHANNEL?: string;
  @IsString() MAIL_FROM: string = "Retailr <noreply@retailr.com>";
  /** Where the web app lives; used to build the links in emails (accept invite, billing). */
  @IsString() APP_PUBLIC_URL: string = "http://localhost:3000";
  /** How the platform collects subscription payments. "none": plan changes apply straight away with no charge (demo). "fake" is for tests and local development only. */
  @IsIn(["none", "paystack", "fake"]) PAYMENTS_DRIVER: string = "none";
  @IsOptional() @IsString() PAYSTACK_SECRET_KEY?: string;
  @IsOptional() @IsString() PAYSTACK_BASE_URL?: string;
  /** "false" turns the background jobs (renewals, trial expiry, cleanup) off, e.g. on a second web instance. */
  @IsIn(["true", "false"]) JOBS_ENABLED: string = "true";
  /** Days a late subscription stays online (retrying the card each day) before the store is suspended. */
  @IsInt() @Min(0) DUNNING_GRACE_DAYS: number = 7;
  @IsOptional() @IsString() SEED_SUPER_ADMIN_EMAIL?: string;
  @IsOptional() @IsString() SEED_SUPER_ADMIN_PASSWORD?: string;
}

/** Fails fast at boot with a readable list of what is missing or wrong. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, { enableImplicitConversion: true, exposeDefaultValues: true });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (!errors.length && env.STORAGE_DRIVER === "s3") {
    const missing = ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "STORAGE_PUBLIC_URL"].filter((k) => !(env as unknown as Record<string, unknown>)[k]);
    if (missing.length) throw new Error(`Invalid environment:\n - STORAGE_DRIVER=s3 needs ${missing.join(", ")}`);
  }
  if (!errors.length && env.PAYMENTS_DRIVER === "paystack" && !env.PAYSTACK_SECRET_KEY) throw new Error("Invalid environment:\n - PAYMENTS_DRIVER=paystack needs PAYSTACK_SECRET_KEY");
  if (!errors.length && env.PAYMENTS_DRIVER === "fake" && env.NODE_ENV === "production") throw new Error("Invalid environment:\n - PAYMENTS_DRIVER=fake is not allowed in production");
  if (!errors.length && env.SMS_DRIVER === "termii" && !env.TERMII_API_KEY) throw new Error("Invalid environment:\n - SMS_DRIVER=termii needs TERMII_API_KEY");
  if (!errors.length && env.MAIL_DRIVER === "smtp" && !env.SMTP_URL) throw new Error("Invalid environment:\n - MAIL_DRIVER=smtp needs SMTP_URL");
  if (errors.length) {
    const lines = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    throw new Error(`Invalid environment:\n - ${lines.join("\n - ")}`);
  }
  return env;
}
