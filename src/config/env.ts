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
  if (errors.length) {
    const lines = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    throw new Error(`Invalid environment:\n - ${lines.join("\n - ")}`);
  }
  return env;
}
