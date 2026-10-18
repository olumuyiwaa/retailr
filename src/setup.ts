import { BadRequestException, INestApplication, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ValidationError } from "class-validator";
import helmet from "helmet";
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
  app.use(helmet());
  app.enableCors({ origin: config.get<string>("CORS_ORIGINS")!.split(",").map((s) => s.trim()), credentials: true });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: false,
    transform: true,
    exceptionFactory: (errors) => AppError.badRequest(firstMessage(errors), "VALIDATION_ERROR") as unknown as BadRequestException,
  }));
}
