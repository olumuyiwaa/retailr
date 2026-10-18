import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant, uploadImage } from "./helpers";

describe("Catalogue", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  let a: Tenant, b: Tenant;
  const product = (over: Record<string, unknown> = {}) => ({ name: "Silk Wrap Dress", sku: "SW-1", category: "", description: "", price: 120, stock: 5, status: "active", ...over });
  const post = (t: Tenant, path: string, body: object) => api().post(`/api/v1${path}`).set(...t.auth).send(body);
  const put = (t: Tenant, path: string, body: object) => api().put(`/api/v1${path}`).set(...t.auth).send(body);
  const get = (t: Tenant, path: string) => api().get(`/api/v1${path}`).set(...t.auth);

  beforeAll(async () => {
    ({ app, prisma, api } = await boot());
    a = await newTenant(api);
    b = await newTenant(api);
  });
  afterAll(async () => { await app.close(); });

  describe("uploads", () => {
    it("stores a file through the signed-URL flow and serves it back", async () => {
      const url = await uploadImage(api, a);
      expect(url).toMatch(new RegExp(`^http://api\\.test/files/${a.businessId}/product/[a-f0-9]{24}\\.png$`));
      const served = await api().get(new URL(url).pathname).expect(200);
      expect(served.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      expect(Buffer.from(served.body).toString()).toBe("fake-png-bytes");
    });

    it("refuses other file types and oversized files before issuing a URL", async () => {
      const svg = await post(a, "/business/uploads", { kind: "logo", contentType: "image/svg+xml", size: 100 }).expect(400);
      expect(svg.body).toMatchObject({ code: "UPLOAD_TYPE", message: "Upload a JPG, PNG, WebP or GIF image." });
      const big = await post(a, "/business/uploads", { kind: "product", contentType: "image/png", size: 5_000_000 }).expect(400);
      expect(big.body.code).toBe("UPLOAD_TOO_LARGE");
    });

    it("rejects tampered, expired and mismatched upload links and enforces the size cap while streaming", async () => {
      const t = (await post(a, "/business/uploads", { kind: "product", contentType: "image/png", size: 10 }).expect(200)).body;
      const u = new URL(t.uploadUrl);
      const bad = u.pathname.replace(/[a-f0-9]{24}/, "0".repeat(24)) + u.search;
      await api().put(bad).set("Content-Type", "image/png").send("x").expect(403);
      const expired = u.pathname + u.search.replace(/exp=\d+/, "exp=1");
      await api().put(expired).set("Content-Type", "image/png").send("x").expect(403);
      await api().put(u.pathname + u.search).set("Content-Type", "image/jpeg").send("x").expect(400);
      const huge = Buffer.alloc(300_000, 1);
      const r = await api().put(u.pathname + u.search).set("Content-Type", "image/png").send(huge);
      expect(r.status).toBe(400);
      await api().get(new URL(t.publicUrl).pathname).expect(404); // nothing was kept
    });

    it("needs a business admin token", async () => {
      await api().post("/api/v1/business/uploads").send({ kind: "product", contentType: "image/png", size: 10 }).expect(401);
    });
  });

  describe("categories", () => {
    it("lists alphabetically with product counts, in the frontend's shape", async () => {
      await post(a, "/business/categories", { name: "Wigs" }).expect(201);
      const dress = (await post(a, "/business/categories", { name: "  Dresses  " }).expect(201)).body;
      expect(dress).toMatchObject({ name: "Dresses", businessId: a.businessId });
      await post(a, "/business/products", product({ category: "dresses" })).expect(201);
      const list = (await get(a, "/business/categories").expect(200)).body;
      expect(list.map((c: any) => [c.name, c.productCount])).toEqual([["Dresses", 1], ["Wigs", 0]]);
    });

    it("rejects blank, long and duplicate names with the UI's messages", async () => {
      expect((await post(a, "/business/categories", { name: "   " }).expect(400)).body.message).toBe("Enter a category name.");
      expect((await post(a, "/business/categories", { name: "x".repeat(41) }).expect(400)).body.message).toBe("Keep category names under 40 characters.");
      const dup = await post(a, "/business/categories", { name: "WIGS" }).expect(409);
      expect(dup.body).toMatchObject({ code: "CATEGORY_EXISTS", message: 'You already have a category called "WIGS".' });
    });

    it("renames without detaching products, and keeps names unique", async () => {
      const cat = (await post(a, "/business/categories", { name: "Bags" }).expect(201)).body;
      const p = (await post(a, "/business/products", product({ name: "Tote", category: "Bags" })).expect(201)).body;
      await api().patch(`/api/v1/business/categories/${cat.id}`).set(...a.auth).send({ name: "Handbags" }).expect(200);
      expect((await get(a, `/business/products/${p.id}`)).body.category).toBe("Handbags");
      const clash = await api().patch(`/api/v1/business/categories/${cat.id}`).set(...a.auth).send({ name: "wigs" }).expect(409);
      expect(clash.body.message).toBe('You already have a category called "wigs".');
    });

    it("sets and removes a cover picture, only from the business's own uploads", async () => {
      const cat = (await post(a, "/business/categories", { name: "Hats" }).expect(201)).body;
      const mine = await uploadImage(api, a, "category");
      const theirs = await uploadImage(api, b, "category");
      expect((await api().patch(`/api/v1/business/categories/${cat.id}`).set(...a.auth).send({ image: theirs }).expect(400)).body.code).toBe("IMAGE_NOT_OWNED");
      expect((await api().patch(`/api/v1/business/categories/${cat.id}`).set(...a.auth).send({ image: "data:image/png;base64,AAAA" }).expect(400)).body.code).toBe("IMAGE_NOT_OWNED");
      expect((await api().patch(`/api/v1/business/categories/${cat.id}`).set(...a.auth).send({ image: mine }).expect(200)).body.image).toBe(mine);
      expect((await api().patch(`/api/v1/business/categories/${cat.id}`).set(...a.auth).send({ image: null }).expect(200)).body.image).toBeUndefined();
    });

    it("delete leaves products on sale but uncategorised, and says how many", async () => {
      const cat = (await post(a, "/business/categories", { name: "Scarves" }).expect(201)).body;
      await post(a, "/business/products", product({ name: "S1", category: "Scarves" })).expect(201);
      await post(a, "/business/products", product({ name: "S2", category: "Scarves" })).expect(201);
      expect((await api().delete(`/api/v1/business/categories/${cat.id}`).set(...a.auth).expect(200)).body).toEqual({ uncategorised: 2 });
      const rows = (await get(a, "/business/products?q=S1").expect(200)).body;
      expect(rows[0]).toMatchObject({ name: "S1", category: "", status: "active" });
    });

    it("never touches another business's categories", async () => {
      const mine = (await post(a, "/business/categories", { name: "Private" }).expect(201)).body;
      await post(b, "/business/categories", { name: "Private" }).expect(201); // same name is fine in another business
      expect((await get(b, "/business/categories")).body.some((c: any) => c.id === mine.id)).toBe(false);
      await api().patch(`/api/v1/business/categories/${mine.id}`).set(...b.auth).send({ name: "Hijack" }).expect(404);
      await api().delete(`/api/v1/business/categories/${mine.id}`).set(...b.auth).expect(404);
      expect((await get(a, "/business/categories")).body.some((c: any) => c.id === mine.id)).toBe(true);
    });
  });

  describe("products", () => {
    it("creates a plain product in the frontend's shape", async () => {
      const r = (await post(a, "/business/products", product({ name: "Plain tee", sku: " T-1 ", description: " Soft ", price: 25.5, stock: 7 })).expect(201)).body;
      expect(r).toMatchObject({ businessId: a.businessId, name: "Plain tee", sku: "T-1", category: "", description: "Soft", price: 25.5, stock: 7, status: "active", sold: 0 });
      expect(r.imageColor).toMatch(/^#/);
      expect(r.images).toBeUndefined();
      expect(r.variants).toBeUndefined();
    });

    it("turns an active product with no stock into out_of_stock", async () => {
      expect((await post(a, "/business/products", product({ name: "Zero", stock: 0 })).expect(201)).body.status).toBe("out_of_stock");
      expect((await post(a, "/business/products", product({ name: "Zero draft", stock: 0, status: "draft" })).expect(201)).body.status).toBe("draft");
    });

    it("only accepts the business's own categories, matching case-insensitively", async () => {
      await post(a, "/business/categories", { name: "Shirts" });
      const ok = (await post(a, "/business/products", product({ name: "Shirt", category: "sHiRtS" })).expect(201)).body;
      expect(ok.category).toBe("Shirts");
      const no = await post(a, "/business/products", product({ category: "Nope" })).expect(400);
      expect(no.body).toMatchObject({ code: "CATEGORY_UNKNOWN", message: "\"Nope\" isn't one of your categories. Add it under Categories first." });
      await post(b, "/business/products", product({ category: "Shirts" })).expect(400); // a's category isn't b's
    });

    it("sums variant stock and keeps variant ids across edits", async () => {
      const p = (await post(a, "/business/products", product({ name: "Dress", stock: 99, variants: [{ name: "Small", stock: 2 }, { name: "Large", stock: 3, price: 130 }] })).expect(201)).body;
      expect(p.stock).toBe(5);
      expect(p.variants.map((v: any) => [v.name, v.price, v.stock])).toEqual([["Small", undefined, 2], ["Large", 130, 3]]);
      const [small, large] = p.variants;
      const edited = (await put(a, `/business/products/${p.id}`, product({ name: "Dress", variants: [{ id: large.id, name: "Large", stock: 10, price: 140 }, { name: "XL", stock: 1 }] })).expect(200)).body;
      expect(edited.stock).toBe(11);
      expect(edited.variants.map((v: any) => v.name)).toEqual(["Large", "XL"]);
      expect(edited.variants[0].id).toBe(large.id); // same row, so past orders still point at it
      expect(await prisma.productVariant.findUnique({ where: { id: small.id } })).toBeNull();
      // PUT without variants removes them and goes back to the plain stock number
      const plain = (await put(a, `/business/products/${p.id}`, product({ name: "Dress", stock: 4 })).expect(200)).body;
      expect(plain.variants).toBeUndefined();
      expect(plain.stock).toBe(4);
    });

    it("validates variants with the UI's messages", async () => {
      const bad = (variants: object[]) => post(a, "/business/products", product({ variants })).expect(400).then((r: any) => r.body.message);
      expect(await bad([{ name: "  ", stock: 1 }])).toBe("Every variant needs a name.");
      expect(await bad([{ name: "S", stock: 1 }, { name: "s", stock: 1 }])).toBe('Two variants are both called "s".');
      expect(await bad([{ name: "S", stock: -1 }])).toBe('Stock for "S" must be a whole number, 0 or more.');
      expect(await bad([{ name: "S", stock: 1.5 }])).toBe('Stock for "S" must be a whole number, 0 or more.');
      expect(await bad([{ name: "S", stock: 1, price: -3 }])).toBe('Enter a valid price for "S".');
    });

    it("refuses to edit another business's variant ids", async () => {
      const p = (await post(a, "/business/products", product({ name: "Mine", variants: [{ name: "One", stock: 1 }] })).expect(201)).body;
      const q = (await post(b, "/business/products", product({ name: "Theirs", variants: [{ name: "One", stock: 1 }] })).expect(201)).body;
      const r = await put(b, `/business/products/${q.id}`, product({ variants: [{ id: p.variants[0].id, name: "One", stock: 99 }] })).expect(400);
      expect(r.body.message).toMatch(/no longer exists/);
      expect((await prisma.productVariant.findUnique({ where: { id: p.variants[0].id } }))!.stock).toBe(1);
    });

    it("validates and clears product details", async () => {
      const bad = (specs: object[]) => post(a, "/business/products", product({ specs })).expect(400).then((r: any) => r.body.message);
      expect(await bad(Array.from({ length: 11 }, (_, i) => ({ label: `L${i}`, value: "v" })))).toBe("A product can have up to 10 details.");
      expect(await bad([{ label: "Material", value: " " }])).toBe("Each product detail needs both a name and a value.");
      expect(await bad([{ label: "x".repeat(31), value: "v" }])).toBe("Keep detail names under 30 characters.");
      expect(await bad([{ label: "k", value: "v".repeat(121) }])).toBe("Keep detail values under 120 characters.");
      const p = (await post(a, "/business/products", product({ name: "Detailed", specs: [{ label: " Material ", value: "Cotton" }, { label: "", value: "" }] })).expect(201)).body;
      expect(p.specs).toEqual([{ label: "Material", value: "Cotton" }]);
      expect((await put(a, `/business/products/${p.id}`, product({ name: "Detailed" })).expect(200)).body.specs).toEqual([{ label: "Material", value: "Cotton" }]); // omitted = unchanged
      expect((await put(a, `/business/products/${p.id}`, product({ name: "Detailed", specs: [] })).expect(200)).body.specs).toBeUndefined();
    });

    it("keeps photos cover-first, limited to six, and only from the business's own uploads", async () => {
      const urls = [await uploadImage(api, a), await uploadImage(api, a), await uploadImage(api, a)];
      const p = (await post(a, "/business/products", product({ name: "Photos", images: urls })).expect(201)).body;
      expect(p.images).toEqual(urls);
      expect(p.image).toBe(urls[0]);
      const reordered = (await put(a, `/business/products/${p.id}`, product({ name: "Photos", images: [urls[2], urls[0]] })).expect(200)).body;
      expect(reordered.images).toEqual([urls[2], urls[0]]);
      expect((await put(a, `/business/products/${p.id}`, product({ name: "Photos" })).expect(200)).body.images).toEqual([urls[2], urls[0]]); // omitted = unchanged
      expect((await put(a, `/business/products/${p.id}`, product({ name: "Photos", images: [] })).expect(200)).body.image).toBeUndefined();
      expect((await post(a, "/business/products", product({ images: Array(7).fill(urls[0]) })).expect(400)).body.message).toBe("A product can have up to 6 photos.");
      const theirs = await uploadImage(api, b);
      expect((await post(a, "/business/products", product({ images: [theirs] })).expect(400)).body.code).toBe("IMAGE_NOT_OWNED");
      expect((await post(a, "/business/products", product({ images: ["https://evil.example/x.png"] })).expect(400)).body.code).toBe("IMAGE_NOT_OWNED");
    });

    it("enforces the plan's product limit, including under concurrent creates", async () => {
      const plan = await prisma.plan.create({ data: { id: `tiny_${run}`, name: "Tiny", priceMonthly: 1, priceYearly: 10, maxProducts: 2, maxStaff: 1, maxOrdersPerMonth: 10, maxStorageGb: 1, features: [] } });
      const c = await newTenant(api);
      await prisma.business.update({ where: { id: c.businessId }, data: { planId: plan.id } });
      const results = await Promise.all([1, 2, 3, 4].map((i) => post(c, "/business/products", product({ name: `P${i}` }))));
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      const blocked = results.find((r) => r.status === 403)!;
      expect(blocked.body).toMatchObject({ code: "PLAN_LIMIT_PRODUCTS", message: "Your Tiny plan is limited to 2 products. Upgrade to add more." });
      expect(await prisma.product.count({ where: { businessId: c.businessId } })).toBe(2);
    });

    it("lists with filters and a total-count header", async () => {
      const d = await newTenant(api);
      await post(d, "/business/categories", { name: "Tops" });
      const cat = (await get(d, "/business/categories")).body[0];
      await post(d, "/business/products", product({ name: "Red Top", sku: "RT", category: "Tops" }));
      await post(d, "/business/products", product({ name: "Blue Top", sku: "BT", category: "Tops", status: "draft" }));
      await post(d, "/business/products", product({ name: "Green Skirt", sku: "GS", stock: 0 }));
      const all = await get(d, "/business/products?limit=2&page=1").expect(200);
      expect(all.body).toHaveLength(2);
      expect(all.headers["x-total-count"]).toBe("3");
      expect((await get(d, "/business/products?q=top")).body.map((p: any) => p.name).sort()).toEqual(["Blue Top", "Red Top"]);
      expect((await get(d, "/business/products?q=gs")).body.map((p: any) => p.name)).toEqual(["Green Skirt"]);
      expect((await get(d, "/business/products?status=draft")).body.map((p: any) => p.name)).toEqual(["Blue Top"]);
      expect((await get(d, "/business/products?status=out_of_stock")).body.map((p: any) => p.name)).toEqual(["Green Skirt"]);
      expect((await get(d, `/business/products?categoryId=${cat.id}`)).body).toHaveLength(2);
      await get(d, "/business/products?limit=500").expect(400);
    });

    it("hides products from other businesses and deletes cleanly", async () => {
      const p = (await post(a, "/business/products", product({ name: "Secret" })).expect(201)).body;
      await get(b, `/business/products/${p.id}`).expect(404);
      await put(b, `/business/products/${p.id}`, product({ name: "Stolen" })).expect(404);
      await api().delete(`/api/v1/business/products/${p.id}`).set(...b.auth).expect(404);
      expect((await get(a, `/business/products/${p.id}`)).body.name).toBe("Secret");
      await api().delete(`/api/v1/business/products/${p.id}`).set(...a.auth).expect(204);
      await get(a, `/business/products/${p.id}`).expect(404);
      expect((await get(b, "/business/products")).body.some((x: any) => x.name === "Secret")).toBe(false);
    });

    it("needs a business admin token", async () => {
      await api().get("/api/v1/business/products").expect(401);
      await api().post("/api/v1/business/products").send(product()).expect(401);
    });

    it("rejects malformed bodies with a plain message", async () => {
      expect((await post(a, "/business/products", { name: "x" }).expect(400)).body.code).toBe("VALIDATION_ERROR");
      expect((await post(a, "/business/products", product({ price: -1 })).expect(400)).body.message).toBe("Enter a valid price.");
      expect((await post(a, "/business/products", product({ stock: 1.5 })).expect(400)).body.message).toBe("Stock must be a whole number, 0 or more.");
      expect((await post(a, "/business/products", product({ status: "weird" })).expect(400)).body.code).toBe("VALIDATION_ERROR");
    });
  });
});
