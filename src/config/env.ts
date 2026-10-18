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
  @IsOptional() @IsString() SEED_SUPER_ADMIN_EMAIL?: string;
  @IsOptional() @IsString() SEED_SUPER_ADMIN_PASSWORD?: string;
}

/** Fails fast at boot with a readable list of what is missing or wrong. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, { enableImplicitConversion: true, exposeDefaultValues: true });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length) {
    const lines = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    throw new Error(`Invalid environment:\n - ${lines.join("\n - ")}`);
  }
  return env;
}
