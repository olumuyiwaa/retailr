import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant } from "./helpers";

describe("Theme gating by plan", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  beforeAll(async () => { ({ app, prisma, api } = await boot()); });
  afterAll(async () => { await app.close(); });

  const setThemes = (id: string, themes: string[]) => prisma.plan.update({ where: { id }, data: { themes } });
  const patch = (t: { auth: [string, string] }, body: object) => api().patch("/api/v1/business/profile").set(...t.auth).send(body);

  it("lets a business pick only themes its plan includes, and always allows classic", async () => {
    await setThemes("plan_growth", ["classic", "showcase"]);
    try {
      const t = await newTenant(api);
      await patch(t, { theme: "showcase" }).expect(200);
      const denied = await patch(t, { theme: "atelier" }).expect(403);
      expect(denied.body.code).toBe("THEME_NOT_IN_PLAN");
      await patch(t, { theme: "classic" }).expect(200);
      await patch(t, { theme: null }).expect(200);
    } finally {
      await setThemes("plan_growth", ["classic", "showcase", "atelier", "market"]);
    }
  });

  it("serves the default theme on the storefront once the plan no longer includes the saved one", async () => {
    const t = await newTenant(api);
    await patch(t, { theme: "market" }).expect(200);
    const slug = (await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).slug;
    expect((await api().get(`/api/v1/store/${slug}`).expect(200)).body.theme).toBe("market");
    await setThemes("plan_growth", ["classic"]);
    try {
      expect((await api().get(`/api/v1/store/${slug}`).expect(200)).body.theme).toBeUndefined();
    } finally {
      await setThemes("plan_growth", ["classic", "showcase", "atelier", "market"]);
    }
  });

  it("exposes themes on plans, always including classic", async () => {
    const plans = (await api().get("/api/v1/plans").expect(200)).body;
    for (const p of plans) expect(p.themes).toContain("classic");
  });
});
