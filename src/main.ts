import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { configureApp } from "./setup";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  const config = app.get(ConfigService);
  if (config.get("NODE_ENV") !== "production") {
    const doc = new DocumentBuilder().setTitle("Retailr API").setVersion("0.1").addBearerAuth().build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, doc));
  }
  app.enableShutdownHooks();
  await app.listen(config.get<number>("PORT") ?? 4000);
}
bootstrap();
