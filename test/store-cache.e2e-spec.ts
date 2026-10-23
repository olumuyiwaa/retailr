import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant } from "./helpers";

describe("Storefront caching", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  beforeAll(async () => { ({ app, prisma, api } = await boot()); });
  afterAll(async () => { await app.close(); });

  it("lets a CDN reuse the public listings briefly, but never the order pages", async () => {
    const t = await newTenant(api);
    const slug = (await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).slug;
    for (const path of ["", "/products", "/services", "/categories"]) {
      const r = await api().get(`/api/v1/store/${slug}${path}`).expect(200);
      expect(r.headers["cache-control"]).toMatch(/s-maxage=\d+/);
      expect(r.headers["cache-control"]).toContain("public");
    }
    const gone = await api().get("/api/v1/store/orders/not-a-real-token").expect(404);
    expect(gone.headers["cache-control"]).toBe("private, no-store");
  });
});
