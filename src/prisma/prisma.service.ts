import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { tenantExtension } from "./tenant";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>("DATABASE_URL"),
        // Serverless Postgres (Neon, Supabase) suspends idle compute and drops its connections. Close ours first, wait long enough
        // for a cold start to wake, and keep live sockets alive so a half-dead one is noticed.
        max: Number(process.env.DB_POOL_MAX) || 10,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 20_000,
        keepAlive: true,
      }),
    });
  }

  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }

  /** A client that can only see and write one business's rows. Use this for everything a business admin does. */
  forBusiness(businessId: string) {
    return this.$extends(tenantExtension(businessId));
  }
}
