import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { configureApp } from "../src/setup";

export const run = Math.random().toString(36).slice(2, 8);
let n = 0;

export async function boot(extra: { controllers?: any[] } = {}) {
  const mod = await Test.createTestingModule({ imports: [AppModule], controllers: extra.controllers ?? [] }).compile();
  const app: INestApplication = mod.createNestApplication({ rawBody: true });
  configureApp(app);
  await app.init();
  return { app, prisma: app.get(PrismaService), api: () => request(app.getHttpServer()) };
}

export interface Tenant { businessId: string; token: string; auth: [string, string]; email: string }

/** Registers a fresh business (Growth plan unless told otherwise) and returns its token. */
export async function newTenant(api: () => request.Test | any, over: Record<string, unknown> = {}): Promise<Tenant> {
  const email = `t${++n}.${run}@example.com`;
  const r = await api().post("/api/v1/auth/register").send({
    ownerName: "Test Owner", email, password: "password123", businessName: `Shop ${run} ${n}`, category: "Fashion & Textiles",
    country: "Nigeria", city: "Lagos", planId: "plan_growth", cycle: "monthly", ...over,
  }).expect(201);
  return { businessId: r.body.user.businessId, token: r.body.accessToken, auth: ["Authorization", `Bearer ${r.body.accessToken}`], email };
}

/** Uploads a tiny real file through the whole flow and returns its public URL. */
export async function uploadImage(api: () => any, t: Tenant, kind: "product" | "category" | "logo" = "product", bytes = Buffer.from("fake-png-bytes")): Promise<string> {
  const ticket = (await api().post("/api/v1/business/uploads").set(...t.auth).send({ kind, contentType: "image/png", size: bytes.length }).expect(200)).body;
  const url = new URL(ticket.uploadUrl);
  await api().put(url.pathname + url.search).set("Content-Type", "image/png").send(bytes).expect(200);
  return ticket.publicUrl;
}
