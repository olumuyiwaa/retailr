import { BadRequestException, INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ValidationError } from "class-validator";
import helmet from "helmet";
import express from "express";
import { resolve } from "path";
import { AppError } from "./common/errors";

const firstMessage = (errors: ValidationError[]): string => {
  for (const e of errors) {
    if (e.constraints) return Object.values(e.constraints)[0];
    if (e.children?.length) return firstMessage(e.children);
  }
  return "Please check what you entered.";
};

/** Shared by main.ts and the e2e tests so both run the app the same way. */
export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);
  app.setGlobalPrefix("api/v1");
  // behind a load balancer, rate limits and analytics need the real client address: TRUST_PROXY = how many proxies sit in front (0 = none)
  const hops = Number(process.env.TRUST_PROXY ?? 0);
  if (hops > 0) app.getHttpAdapter().getInstance().set("trust proxy", hops);
  // images are loaded from the storefront's own origin, so they must be embeddable cross-origin
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  if ((config.get("STORAGE_DRIVER") ?? "local") === "local") {
    app.use("/files", express.static(resolve(config.get<string>("LOCAL_UPLOAD_DIR") ?? "./uploads"), { immutable: true, maxAge: "1y", index: false, dotfiles: "deny" }));
  }
  app.enableCors({ origin: config.get<string>("CORS_ORIGINS")!.split(",").map((s) => s.trim()), credentials: true });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    exceptionFactory: (errors) => AppError.badRequest(firstMessage(errors), "VALIDATION_ERROR") as unknown as BadRequestException,
  }));
}
