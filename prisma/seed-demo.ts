// Seeds a complete demo business, "Scentora" (a perfume shop in Lagos): catalogue, customers, two months of orders, discount codes, groups,
// a sent message, a three-person team, bookable services and a batch of bookings.
// Safe to run again: it replaces the demo business and leaves everything else alone.
// Usage: npm run seed:demo   (run `npm run seed` first for the plans). Storefront: /s/scentora
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma, OrderStatus, PaymentMethod, SalesChannel, BookingStatus } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const DAY = 86_400_000;
const SLUG = "scentora";
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "Demo@12345";
const D = (n: number) => new Prisma.Decimal(n);

/** Deterministic randomness, so every run produces the same shop. */
let seed = 20261021;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

type P = { name: string; cat: string; desc: string; color: string; sku: string; sizes: [string, number, number][]; specs: [string, string][]; status?: "DRAFT" };
const sz = (a: number, b: number, c: number, s = [14, 22, 9]): [string, number, number][] => [["30ml", a, s[0]], ["50ml", b, s[1]], ["100ml", c, s[2]]];

/** Unsplash photos of unbranded perfume bottles (free to hotlink under the Unsplash licence). Branded ones are left out on purpose: this is a made-up shop. */
const PHOTO = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=900&q=80`;
const PHOTOS = [
  "1594035910387-fea47794261f", // black and gold bottle
  "1458538977777-0549b2370168", // clear bottle
  "1590736704728-f4730bb30770", // hand holding a glass bottle
  "1622618991746-fe6004db3a47", // bottle and jars on yellow
  "1615634260167-c8cdede054de", // glass bottle, selective focus
  "1543422655-ac1c6ca993ed", // glass bottle
  "1593487568720-92097fb460fb", // bottle on a wooden table
  "1723391962154-8a2b6299bc09", // bottle on a table
].map(PHOTO);

const CATEGORIES = ["Women", "Men", "Unisex", "Oud & Attar", "Body Mist", "Gift Sets"];
const PRODUCTS: P[] = [
  { name: "Lagos Nights", cat: "Women", sku: "SC-W-001", color: "#e8c5d8", desc: "Jasmine, black plum and warm amber. An evening scent that lingers.", sizes: sz(18000, 28000, 45000), specs: [["Family", "Floral amber"], ["Notes", "Jasmine, plum, amber"], ["Longevity", "8-10 hours"]] },
  { name: "Harmattan Rose", cat: "Women", sku: "SC-W-002", color: "#f4b6c2", desc: "Damask rose with a dry, peppery edge and soft musk.", sizes: sz(16500, 26000, 42000), specs: [["Family", "Rose musk"], ["Notes", "Rose, pink pepper, musk"], ["Longevity", "6-8 hours"]] },
  { name: "Velvet Orchid", cat: "Women", sku: "SC-W-003", color: "#b79ad6", desc: "Creamy orchid over vanilla bean and sandalwood.", sizes: sz(19500, 30000, 48000), specs: [["Family", "Gourmand floral"], ["Notes", "Orchid, vanilla, sandalwood"], ["Longevity", "8 hours"]] },
  { name: "Sunset on Banana Island", cat: "Women", sku: "SC-W-004", color: "#ffd29c", desc: "Bright mandarin and coconut water, a light everyday summer scent.", sizes: sz(15000, 24000, 38000, [20, 30, 14]), specs: [["Family", "Fresh fruity"], ["Notes", "Mandarin, coconut, white musk"], ["Longevity", "5-6 hours"]] },
  { name: "Iron & Cedar", cat: "Men", sku: "SC-M-001", color: "#9aa7b4", desc: "Crisp bergamot over cedarwood and vetiver. Clean, confident, office-ready.", sizes: sz(17000, 27000, 44000), specs: [["Family", "Woody fresh"], ["Notes", "Bergamot, cedar, vetiver"], ["Longevity", "7-9 hours"]] },
  { name: "Midnight Suya", cat: "Men", sku: "SC-M-002", color: "#c0764a", desc: "Smoky pepper, tobacco leaf and a sweet caramel base. Bold by design.", sizes: sz(18500, 29000, 46000), specs: [["Family", "Spicy smoky"], ["Notes", "Pepper, tobacco, caramel"], ["Longevity", "9-11 hours"]] },
  { name: "Ocean Drive", cat: "Men", sku: "SC-M-003", color: "#8ec9e6", desc: "Sea salt, grapefruit and driftwood.", sizes: sz(15500, 25000, 40000, [18, 26, 12]), specs: [["Family", "Aquatic"], ["Notes", "Sea salt, grapefruit, driftwood"], ["Longevity", "6 hours"]] },
  { name: "Gold Leaf", cat: "Men", sku: "SC-M-004", color: "#e3c565", desc: "Saffron, leather and amberwood. Dressed-up and unmistakable.", sizes: sz(21000, 33000, 52000, [8, 12, 6]), specs: [["Family", "Leather amber"], ["Notes", "Saffron, leather, amberwood"], ["Longevity", "10+ hours"]] },
  { name: "Cloud Nine", cat: "Unisex", sku: "SC-U-001", color: "#e9eef7", desc: "Soft white musk, cashmere wood and a touch of pear.", sizes: sz(14500, 23000, 36000), specs: [["Family", "Musk"], ["Notes", "White musk, pear, cashmere wood"], ["Longevity", "6-7 hours"]] },
  { name: "Palm Wine", cat: "Unisex", sku: "SC-U-002", color: "#f3e3a6", desc: "Sweet, slightly fermented palm sap with fig and honey. Our signature.", sizes: sz(17500, 27500, 43000), specs: [["Family", "Gourmand"], ["Notes", "Palm sap, fig, honey"], ["Longevity", "7-9 hours"]] },
  { name: "Royal Oud", cat: "Oud & Attar", sku: "SC-O-001", color: "#6b4a3a", desc: "Aged oud with rose and a trace of smoke. Concentrated parfum oil.", sizes: [["6ml", 24000, 10], ["12ml", 42000, 8], ["50ml", 95000, 4]], specs: [["Type", "Parfum oil"], ["Notes", "Oud, rose, smoke"], ["Longevity", "12+ hours"]] },
  { name: "White Musk Attar", cat: "Oud & Attar", sku: "SC-O-002", color: "#f2efe6", desc: "Alcohol-free roll-on musk oil, gentle on skin.", sizes: [["6ml", 9500, 40], ["12ml", 16000, 25]], specs: [["Type", "Alcohol-free oil"], ["Notes", "White musk"], ["Longevity", "5-6 hours"]] },
  { name: "Amber Oud Roll-on", cat: "Oud & Attar", sku: "SC-O-003", color: "#a56a35", desc: "Warm amber and oud in a pocket-size roll-on.", sizes: [["6ml", 12500, 30]], specs: [["Type", "Roll-on oil"], ["Notes", "Amber, oud"], ["Longevity", "8 hours"]] },
  { name: "Cotton Bloom Body Mist", cat: "Body Mist", sku: "SC-B-001", color: "#fbe1ea", desc: "Light, airy and layerable. Spritz all day.", sizes: [["150ml", 6500, 60], ["250ml", 9500, 40]], specs: [["Type", "Body mist"], ["Notes", "Cotton blossom, peach"]] },
  { name: "Vanilla Sugar Body Mist", cat: "Body Mist", sku: "SC-B-002", color: "#f7e6c4", desc: "Warm vanilla and brown sugar.", sizes: [["150ml", 6500, 55], ["250ml", 9500, 35]], specs: [["Type", "Body mist"], ["Notes", "Vanilla, brown sugar"]] },
  { name: "The Discovery Set", cat: "Gift Sets", sku: "SC-G-001", color: "#d9c3a5", desc: "Six 5ml minis: one from each family, to find your signature.", sizes: [["6 x 5ml", 22000, 45]], specs: [["Contents", "6 x 5ml sprays"], ["Includes", "Gift box and card"]] },
  { name: "Her & Him Gift Box", cat: "Gift Sets", sku: "SC-G-002", color: "#c9a0a0", desc: "Lagos Nights and Iron & Cedar (50ml each) in a ribboned box.", sizes: [["2 x 50ml", 52000, 15]], specs: [["Contents", "2 x 50ml EDP"], ["Includes", "Gift box, ribbon and card"]] },
  { name: "Limited: Detty December", cat: "Unisex", sku: "SC-U-003", color: "#7ad1a8", desc: "A festive, sparkling citrus-spice blend, coming soon.", sizes: sz(19000, 30000, 47000, [0, 0, 0]), specs: [["Family", "Spicy citrus"]], status: "DRAFT" },
];

type SvcOpt = { name: string; price: number };
type Svc = {
  name: string; cat: string; desc: string; color: string;
  price: number; durationMins: number; bookable: boolean;
  maxConcurrent?: number; specs: [string, string][];
  options?: SvcOpt[];
};
const SERVICES: Svc[] = [
  {
    name: "Fragrance Consultation", cat: "Unisex",
    desc: "A one-on-one session with our in-house perfumer. We map your scent preferences and build a personalised fragrance wardrobe.",
    color: "#e8d5c4", price: 15000, durationMins: 60, bookable: true, maxConcurrent: 2,
    specs: [["Duration", "60 minutes"], ["Includes", "Scent profile report + 5ml sample"], ["Where", "Lagos Island boutique or video call"]],
    options: [
      { name: "In-store (60 min)", price: 15000 },
      { name: "Video call (45 min)", price: 10000 },
    ],
  },
  {
    name: "Custom Blending Session", cat: "Unisex",
    desc: "Design your own signature scent with our perfumer. You leave with a 30ml bottle of your creation.",
    color: "#d4c5e8", price: 35000, durationMins: 90, bookable: true, maxConcurrent: 1,
    specs: [["Duration", "90 minutes"], ["Includes", "30ml bespoke bottle + recipe card"], ["Where", "Lagos Island boutique"]],
    options: [
      { name: "Solo session (30ml)", price: 35000 },
      { name: "Couples session (2 × 30ml)", price: 60000 },
    ],
  },
  {
    name: "Gift Wrapping & Personalisation", cat: "Gift Sets",
    desc: "Premium wrapping, a handwritten card and optional monogramming for any purchase. Add it to any order.",
    color: "#c5dce8", price: 2500, durationMins: undefined as unknown as number, bookable: false,
    specs: [["Turnaround", "Same day in-store, +1 day for delivery"], ["Includes", "Branded box, ribbon, card"]],
    options: [
      { name: "Standard wrap + card", price: 2500 },
      { name: "Premium box + monogram", price: 5000 },
    ],
  },
  {
    name: "Scent Layering Workshop", cat: "Unisex",
    desc: "A small-group class (up to 6) where we teach the art of layering fragrances to create a signature combination.",
    color: "#e8e4c5", price: 12000, durationMins: 120, bookable: true, maxConcurrent: 6,
    specs: [["Duration", "2 hours"], ["Includes", "Materials, refreshments and a take-home sample"], ["Group size", "Up to 6 people"]],
  },
  {
    name: "Corporate & Bulk Orders", cat: "Gift Sets",
    desc: "Branded gift sets for events, weddings or corporate gifting. Price is per unit; minimum 10 units.",
    color: "#c5e8d0", price: 18000, durationMins: undefined as unknown as number, bookable: false,
    specs: [["Minimum", "10 units"], ["Lead time", "5–7 business days"], ["Includes", "Custom branding on packaging"]],
    options: [
      { name: "10–49 units", price: 18000 },
      { name: "50–99 units", price: 16000 },
      { name: "100+ units", price: 14000 },
    ],
  },
];

const CUSTOMERS: [string, string, string, string][] = [
  ["Adaeze Okafor", "adaeze.okafor@example.com", "08031230001", "Lagos"], ["Tunde Bakare", "tunde.bakare@example.com", "08031230002", "Lagos"],
  ["Ngozi Eze", "ngozi.eze@example.com", "08031230003", "Abuja"], ["Chinedu Obi", "chinedu.obi@example.com", "08031230004", "Port Harcourt"],
  ["Funke Adeyemi", "funke.adeyemi@example.com", "08031230005", "Ibadan"], ["Ibrahim Musa", "ibrahim.musa@example.com", "08031230006", "Abuja"],
  ["Sade Williams", "sade.williams@example.com", "08031230007", "Lagos"], ["Emeka Nwosu", "emeka.nwosu@example.com", "08031230008", "Enugu"],
  ["Amaka Johnson", "amaka.johnson@example.com", "08031230009", "Lagos"], ["Kelechi Anya", "kelechi.anya@example.com", "08031230010", "Lagos"],
  ["Bisi Ogunleye", "bisi.ogunleye@example.com", "08031230011", "Abeokuta"], ["Yusuf Danjuma", "yusuf.danjuma@example.com", "08031230012", "Kano"],
  ["Titi Alabi", "titi.alabi@example.com", "08031230013", "Lagos"], ["Obinna Uche", "obinna.uche@example.com", "08031230014", "Lagos"],
];

async function main() {
  const plan = await prisma.plan.findUnique({ where: { id: "plan_growth" } });
  if (!plan) throw new Error("Run `npm run seed` first: the plans don't exist yet.");

  await prisma.user.deleteMany({ where: { email: { in: ["demo@scentora.example", "manager@scentora.example", "staff@scentora.example"] } } });
  await prisma.business.deleteMany({ where: { slug: SLUG } }); // cascades to everything the demo created

  const hash = await argon2.hash(PASSWORD);
  const now = Date.now();
  const biz = await prisma.business.create({
    data: {
      name: "Scentora", slug: SLUG, category: "Beauty & Fragrance", ownerName: "Amara Dike", ownerEmail: "demo@scentora.example", phone: "08030001000",
      country: "Nigeria", city: "Lagos", currency: "NGN", brandColor: "#8b5e3c", status: "ACTIVE", planId: plan.id,
      description: "Niche and everyday fragrances, blended for the African sun. Authentic oils, long-lasting sprays and gift sets, delivered nationwide.",
      createdAt: new Date(now - 75 * DAY),
    },
  });
  await prisma.subscription.create({ data: { businessId: biz.id, planId: plan.id, status: "ACTIVE", cycle: "MONTHLY", amount: plan.priceMonthly, currentPeriodEnd: new Date(now + 18 * DAY) } });

  // team: owner, manager, staff (all with the same demo password)
  const team: [string, string, "OWNER" | "MANAGER" | "STAFF"][] = [["Amara Dike", "demo@scentora.example", "OWNER"], ["Kunle Peters", "manager@scentora.example", "MANAGER"], ["Zainab Lawal", "staff@scentora.example", "STAFF"]];
  for (const [name, email, role] of team) {
    const u = await prisma.user.create({ data: { email, name, passwordHash: hash, role: "BUSINESS_ADMIN", businessId: biz.id, emailVerifiedAt: new Date() } });
    await prisma.teamMember.create({ data: { businessId: biz.id, userId: u.id, name, email, role, status: "ACTIVE" } });
  }

  // catalogue
  const cats = new Map<string, string>();
  for (const [i, name] of CATEGORIES.entries()) cats.set(name, (await prisma.category.create({ data: { businessId: biz.id, name, imageUrl: PHOTOS[(i * 3) % PHOTOS.length] } })).id);
  const products: { id: string; name: string; status: string; variants: { id: string; name: string; price: number }[] }[] = [];
  for (const [pi, p] of PRODUCTS.entries()) {
    const draft = p.status === "DRAFT";
    const stock = p.sizes.reduce((a, s) => a + s[2], 0);
    const prod = await prisma.product.create({
      data: {
        businessId: biz.id, categoryId: cats.get(p.cat), name: p.name, sku: p.sku, description: p.desc, price: D(p.sizes[0][1]), stock, imageColor: p.color,
        status: draft ? "DRAFT" : stock === 0 ? "OUT_OF_STOCK" : "ACTIVE", specs: p.specs.map(([label, value]) => ({ label, value })),
        // a cover plus a second angle, from the shared set (the same photo never appears twice on one product)
        images: { create: [0, 1 + (pi % 3)].map((k, position) => ({ url: PHOTOS[(pi + k) % PHOTOS.length], position })) },
        variants: { create: p.sizes.map(([name, price, st], position) => ({ name, price: D(price), stock: st, position })) },
      },
      include: { variants: true },
    });
    products.push({ id: prod.id, name: prod.name, status: prod.status, variants: prod.variants.map((v) => ({ id: v.id, name: v.name, price: Number(v.price) })) });
  }
  const sellable = products.filter((p) => p.status === "ACTIVE");

  // customers
  const customers = [];
  for (const [i, [name, email, phone, city]] of CUSTOMERS.entries()) {
    customers.push(await prisma.customer.create({ data: { businessId: biz.id, name, email, phone, city, createdAt: new Date(now - (70 - i * 4) * DAY) } }));
  }

  // coupons
  await prisma.coupon.createMany({ data: [
    { businessId: biz.id, code: "WELCOME10", type: "PERCENT", value: D(10), maxUses: 200, expiresAt: new Date(now + 90 * DAY) },
    { businessId: biz.id, code: "DETTY5000", type: "FIXED", value: D(5000), minOrder: D(40000), maxUses: 50, expiresAt: new Date(now + 70 * DAY) },
    { businessId: biz.id, code: "BLACKFRIDAY", type: "PERCENT", value: D(25), status: "DISABLED", expiresAt: new Date(now + 40 * DAY) },
  ] });

  // orders: roughly two months, busier lately
  const channels: SalesChannel[] = ["ONLINE", "ONLINE", "ONLINE", "INSTAGRAM", "INSTAGRAM", "WHATSAPP", "IN_STORE"];
  let seq = 999, count = 0;
  const sold = new Map<string, number>();
  const spent = new Map<string, { n: number; t: number }>();
  const total = 70;
  for (let i = 0; i < total; i++) {
    const age = Math.floor(60 * Math.pow(rnd(), 1.4)); // more recent orders than old ones
    const placedAt = new Date(now - age * DAY - Math.floor(rnd() * 12) * 3_600_000);
    const c = pick(customers);
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
      const p = pick(sellable), v = pick(p.variants);
      return { p, v, qty: 1 + (rnd() < 0.25 ? 1 : 0) };
    });
    const subtotal = lines.reduce((a, l) => a + l.v.price * l.qty, 0);
    const useCoupon = rnd() < 0.2, discount = useCoupon ? Math.round(subtotal * 0.1) : 0;
    const status: OrderStatus = age > 12 ? (rnd() < 0.07 ? "CANCELLED" : "DELIVERED") : age > 6 ? pick(["DELIVERED", "SHIPPED", "SHIPPED"] as const) : age > 2 ? pick(["PROCESSING", "SHIPPED"] as const) : "PENDING";
    const channel = pick(channels);
    const method: PaymentMethod = channel === "IN_STORE" ? pick(["CASH", "POS"] as const) : pick(["CARD", "CARD", "BANK", "COD"] as const);
    const paid = status !== "CANCELLED" && (status !== "PENDING" || method === "CARD") && (method !== "COD" || status === "DELIVERED");
    const number = `SC${++seq}`;
    await prisma.order.create({
      data: {
        businessId: biz.id, number, customerId: c.id, customerName: c.name, customerEmail: c.email, customerPhone: c.phone, shippingAddress: `${c.city}, Nigeria`,
        channel, paymentMethod: method, status, paymentStatus: paid ? "PAID" : "UNPAID", subtotal: D(subtotal), discount: D(discount), total: D(subtotal - discount),
        couponCode: useCoupon ? "WELCOME10" : null, placedAt,
        items: { create: lines.map((l) => ({ productId: l.p.id, variantId: l.v.id, name: `${l.p.name} (${l.v.name})`, qty: l.qty, price: D(l.v.price) })) },
      },
    });
    count++;
    if (status !== "CANCELLED") for (const l of lines) sold.set(l.p.id, (sold.get(l.p.id) ?? 0) + l.qty);
    if (paid) { const s = spent.get(c.id) ?? { n: 0, t: 0 }; spent.set(c.id, { n: s.n + 1, t: s.t + subtotal - discount }); }
  }
  await prisma.business.update({ where: { id: biz.id }, data: { orderSeq: seq } });
  for (const [id, n] of sold) await prisma.product.update({ where: { id }, data: { sold: n } });
  for (const [id, s] of spent) await prisma.customer.update({ where: { id }, data: { ordersCount: s.n, totalSpent: D(s.t) } });
  await prisma.coupon.updateMany({ where: { businessId: biz.id, code: "WELCOME10" }, data: { usedCount: await prisma.order.count({ where: { businessId: biz.id, couponCode: "WELCOME10" } }) } });

  // services
  const services: { id: string; name: string; price: number; options: { id: string; name: string; price: number }[] }[] = [];
  for (const [si, svc] of SERVICES.entries()) {
    const created = await prisma.service.create({
      data: {
        businessId: biz.id,
        categoryId: cats.get(svc.cat),
        name: svc.name,
        description: svc.desc,
        price: D(svc.price),
        durationMins: svc.durationMins ?? null,
        bookable: svc.bookable,
        maxConcurrent: svc.maxConcurrent ?? 1,
        imageColor: svc.color,
        status: "ACTIVE",
        specs: svc.specs.map(([label, value]) => ({ label, value })),
        images: {
          create: [{ url: PHOTOS[(si * 2 + 3) % PHOTOS.length], position: 0 }],
        },
        options: svc.options?.length
          ? { create: svc.options.map((o, pos) => ({ name: o.name, price: D(o.price), position: pos })) }
          : undefined,
      },
      include: { options: true },
    });
    services.push({
      id: created.id, name: created.name, price: svc.price,
      options: created.options.map((o) => ({ id: o.id, name: o.name, price: Number(o.price ?? svc.price) })),
    });
  }

  // bookings: ~30, spread over the past 45 days and the next 14
  const bookableSvcs = services.filter((s) => SERVICES.find((d) => d.name === s.name)?.bookable);
  const bookingStatuses: BookingStatus[] = ["CONFIRMED", "CONFIRMED", "CONFIRMED", "COMPLETED", "COMPLETED", "CANCELLED", "NO_SHOW"];
  let bookingCount = 0;
  for (let i = 0; i < 30; i++) {
    const svc = pick(bookableSvcs);
    const svcDef = SERVICES.find((d) => d.name === svc.name)!;
    const opt = svc.options.length ? pick(svc.options) : null;
    const price = opt ? opt.price : svc.price;
    const durationMins = svcDef.durationMins;
    // past bookings: 1-45 days ago. future: next 1-14 days
    const isFuture = i < 8;
    const offsetDays = isFuture ? -(1 + Math.floor(rnd() * 14)) : 1 + Math.floor(rnd() * 44);
    const hour = 9 + Math.floor(rnd() * 8); // 09:00–16:00
    const startsAt = new Date(now + offsetDays * DAY * (isFuture ? -1 : 1));
    startsAt.setHours(hour, 0, 0, 0);
    const endsAt = new Date(startsAt.getTime() + durationMins * 60_000);
    const c = pick(customers);
    const status: BookingStatus = isFuture ? "CONFIRMED" : pick(bookingStatuses);
    await prisma.booking.create({
      data: {
        businessId: biz.id,
        serviceId: svc.id,
        customerId: c.id,
        serviceName: svc.name,
        variantName: opt?.name ?? null,
        price: D(price),
        startsAt, endsAt, status,
        customerName: c.name, customerEmail: c.email, customerPhone: c.phone,
        source: rnd() < 0.7 ? "store" : "admin",
      },
    });
    if (status === "COMPLETED") await prisma.service.update({ where: { id: svc.id }, data: { sold: { increment: 1 } } });
    bookingCount++;
  }

  // groups and one sent message
  const vip = await prisma.customerGroup.create({ data: { businessId: biz.id, name: "VIP buyers", description: "Spent over ₦100,000", kind: "AUTO", ruleType: "SPENT_OVER", ruleValue: D(100000) } });
  await prisma.customerGroup.create({ data: { businessId: biz.id, name: "Lapsed (60 days)", description: "No order in two months", kind: "AUTO", ruleType: "NO_ORDER_WITHIN_DAYS", ruleValue: D(60) } });
  const gifting = await prisma.customerGroup.create({ data: { businessId: biz.id, name: "Gift shoppers", description: "Bought gift sets", kind: "MANUAL" } });
  await prisma.customerGroupMember.createMany({ data: customers.slice(0, 4).map((c) => ({ groupId: gifting.id, customerId: c.id })) });
  await prisma.message.create({
    data: {
      businessId: biz.id, channel: "EMAIL", subject: "A little something for you, {{first_name}}", audienceLabel: "All customers", recipientCount: customers.length, sentCount: customers.length, failedCount: 0,
      body: "Hi {{first_name}}, thank you for shopping with {{store}}. Use WELCOME10 for 10% off your next bottle.", sentAt: new Date(now - 9 * DAY),
    },
  });

  console.log(`Seeded "${biz.name}": ${products.length} products, ${services.length} services, ${customers.length} customers, ${count} orders, ${bookingCount} bookings.`);
  console.log(`Storefront: /s/${SLUG}`);
  console.log(`Logins (password "${PASSWORD}"): demo@scentora.example (owner), manager@scentora.example, staff@scentora.example`);
  void vip;
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
