// Seeds the reference data every environment needs (plans, a super admin) and a few platform discounts.
// Safe to run more than once. Usage: npm run seed
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
const day = 86_400_000;

const plans: Prisma.PlanCreateInput[] = [
  {
    id: "plan_basic", name: "Basic", description: "Free forever. Open a store and make your first sales.",
    priceMonthly: 0, priceYearly: 0, transactionFeePct: 4, maxProducts: 25, maxStaff: 1, maxOrdersPerMonth: 30, maxStorageGb: 1,
    features: ["Branded online storefront", "Up to 25 products", "30 orders / month", "Discount codes", "Order invoices & receipts", "Community support"],
    localPrices: { NGN: { monthly: 0, yearly: 0 }, GHS: { monthly: 0, yearly: 0 }, KES: { monthly: 0, yearly: 0 } },
  },
  {
    id: "plan_starter", name: "Starter", description: "Everything a new business needs to start selling online.",
    priceMonthly: 3, priceYearly: 30, transactionFeePct: 3, maxProducts: 300, maxStaff: 2, maxOrdersPerMonth: 300, maxStorageGb: 3,
    features: ["Everything in Basic", "Up to 300 products", "2 team members", "300 orders / month", "Basic sales reports", "Email support"],
    localPrices: { NGN: { monthly: 4500, yearly: 45000 }, GHS: { monthly: 45, yearly: 450 }, KES: { monthly: 450, yearly: 4500 } },
  },
  {
    id: "plan_growth", name: "Growth", description: "For growing shops that need more room and better insight.",
    priceMonthly: 6, priceYearly: 60, transactionFeePct: 2, maxProducts: 1500, maxStaff: 5, maxOrdersPerMonth: 2000, maxStorageGb: 10, highlighted: true,
    features: ["Everything in Starter", "Up to 1,500 products", "5 team members", "2,000 orders / month", "Advanced analytics", "Priority support"],
    localPrices: { NGN: { monthly: 9500, yearly: 95000 }, GHS: { monthly: 95, yearly: 950 }, KES: { monthly: 950, yearly: 9500 } },
  },
  {
    id: "plan_scale", name: "Scale", description: "High-volume sellers with teams and custom needs.",
    priceMonthly: 15, priceYearly: 150, transactionFeePct: 1, maxProducts: -1, maxStaff: 15, maxOrdersPerMonth: -1, maxStorageGb: 50,
    features: ["Everything in Growth", "Unlimited products & orders", "15 team members", "Custom domain", "API access", "Dedicated account manager"],
    localPrices: { NGN: { monthly: 22000, yearly: 220000 }, GHS: { monthly: 220, yearly: 2200 }, KES: { monthly: 2200, yearly: 22000 } },
  },
];

async function main() {
  for (const { id, ...data } of plans) {
    await prisma.plan.upsert({ where: { id }, create: { id, ...data }, update: data });
  }

  const email = (process.env.SEED_SUPER_ADMIN_EMAIL ?? "admin@retailr.com").toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    if (!password || password.length < 8) throw new Error("Set SEED_SUPER_ADMIN_PASSWORD (8+ characters) to create the super admin.");
    await prisma.user.create({ data: { email, name: "Retailr Admin", passwordHash: await argon2.hash(password), role: "SUPER_ADMIN", emailVerifiedAt: new Date() } });
    console.log(`Created super admin ${email}`);
  }

  const coupons = [
    { code: "LAUNCH20", type: "PERCENT", value: 20, maxUses: 100, expiresAt: new Date(Date.now() + 60 * day), note: "Launch offer for new sign-ups" },
    { code: "GROWTH15", type: "PERCENT", value: 15, plans: ["plan_growth"], note: "Growth plan promo" },
    { code: "SAVE10", type: "FIXED", value: 10, maxUses: 25, expiresAt: new Date(Date.now() + 30 * day) },
  ] as const;
  for (const c of coupons) {
    await prisma.planCoupon.upsert({
      where: { code: c.code },
      update: {},
      create: {
        code: c.code, type: c.type, value: c.value,
        maxUses: "maxUses" in c ? c.maxUses : undefined, expiresAt: "expiresAt" in c ? c.expiresAt : undefined, note: "note" in c ? c.note : undefined,
        plans: "plans" in c ? { create: c.plans.map((planId) => ({ planId })) } : undefined,
      },
    });
  }
  console.log(`Seeded ${plans.length} plans and ${coupons.length} discount codes`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
