import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { configureApp } from "./setup";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  const config = app.get(ConfigService);
  if (config.get("NODE_ENV") !== "production") {
    const doc = new DocumentBuilder()
      .setTitle("Retailr API").setVersion("1.0")
      .setDescription("Multi-tenant storefronts for small businesses. Everything is under /api/v1. Errors are { statusCode, code, message }. Lists take page and limit and return the total in X-Total-Count. Routes marked with a lock need a bearer token (business admin or super admin).")
      .addBearerAuth().build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, doc), { swaggerOptions: { persistAuthorization: true, tagsSorter: "alpha" } });
  }
  app.enableShutdownHooks();
  await app.listen(config.get<number>("PORT") ?? 4000);
}
bootstrap();
