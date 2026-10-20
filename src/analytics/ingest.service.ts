import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { DEVICES, SOURCES, TrackDto } from "./dto/analytics.dto";

/** Page keys we keep. Anything else is still a page view but is filed under "other", so a client can't grow the stored JSON without limit. */
export const PAGE_KEYS = ["/", "/shop", "/product", "/cart", "/checkout", "/get-started", "/pricing", "/features"] as const;
const MAX_COUNTRY_KEYS = 60;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|monitor/i;
const SCOPE_TTL_MS = 60_000;

type Counts = Record<string, number>;
const bump = (rec: Counts, key: string, by = 1) => { rec[key] = (rec[key] ?? 0) + by; };
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
export const todayUtc = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Turns "/s/my-shop/product/abc?x=1" into "/product". */
export function pageKey(path: string | undefined): string {
  let p = (path ?? "/").split(/[?#]/)[0].toLowerCase();
  p = p.replace(/^\/s\/[^/]+/, "") || "/";
  if (p.length > 1) p = p.replace(/\/+$/, "");
  const first = "/" + (p.split("/")[1] ?? "");
  return (PAGE_KEYS as readonly string[]).includes(first) ? first : "other";
}

/** Records what visitors do. Public and unauthenticated, so it trusts nothing: ids are hashed, enums are checked, keys are bounded. */
@Injectable()
export class IngestService {
  private scopes = new Map<string, { ok: boolean; at: number }>();
  constructor(private readonly prisma: PrismaService) {}

  /** True for the marketing site and for stores that are open (active or on trial). Cached briefly because every page view asks. */
  private async scopeOpen(scope: string): Promise<boolean> {
    if (scope === "platform") return true;
    const hit = this.scopes.get(scope);
    if (hit && Date.now() - hit.at < SCOPE_TTL_MS) return hit.ok;
    const b = await this.prisma.business.findUnique({ where: { id: scope }, select: { status: true } });
    const ok = !!b && (b.status === "ACTIVE" || b.status === "TRIAL");
    if (this.scopes.size > 5000) this.scopes.clear();
    this.scopes.set(scope, { ok, at: Date.now() });
    return ok;
  }

  /** Marks something as seen today; true only the first time. */
  private async firstTime(tx: Prisma.TransactionClient, scope: string, date: Date, kind: "v" | "s" | "p" | "c" | "k" | "o", id: string) {
    const r = await tx.analyticsSeen.createMany({ data: [{ scope, date, kind, keyHash: hash(`${scope}|${kind}|${id}`) }], skipDuplicates: true });
    return r.count === 1;
  }

  async track(dto: TrackDto, userAgent = ""): Promise<void> {
    if (BOT.test(userAgent)) return;
    if (!(await this.scopeOpen(dto.scope))) return;
    const scope = dto.scope, date = todayUtc();

    // products must belong to this store; anything else is dropped
    const wanted = [...new Set(dto.events.filter((e) => e.type === "product" && e.productId).map((e) => e.productId!))];
    const real = scope === "platform" || !wanted.length
      ? new Set<string>()
      : new Set((await this.prisma.product.findMany({ where: { businessId: scope, id: { in: wanted }, status: { not: "DRAFT" } }, select: { id: true } })).map((p) => p.id));

    await this.prisma.$transaction(async (tx) => {
      const newVisitor = await this.firstTime(tx, scope, date, "v", dto.visitorId);
      const newSession = await this.firstTime(tx, scope, date, "s", dto.sessionId);

      const add = { visitors: newVisitor ? 1 : 0, sessions: newSession ? 1 : 0, pageViews: 0, productViews: 0, addToCart: 0, checkouts: 0, productSessions: 0, cartSessions: 0, checkoutSessions: 0, orderSessions: 0 };
      let sawProduct = false, sawCart = false, sawCheckout = false, sawOrder = false;
      const pages: Counts = {}, products: Counts = {}, sources: Counts = {}, devices: Counts = {}, countries: Counts = {};
      for (const e of dto.events) {
        if (e.type === "page") { add.pageViews++; bump(pages, pageKey(e.path)); }
        else if (e.type === "product") { if (e.productId && (scope === "platform" || real.has(e.productId))) { add.productViews++; sawProduct = true; if (scope !== "platform") bump(products, e.productId); } }
        else if (e.type === "add_to_cart") { add.addToCart++; sawCart = true; }
        else if (e.type === "order") sawOrder = true;
        else { add.checkouts++; sawCheckout = true; }
      }
      // funnel steps count each session once, however many events it sent
      if (sawProduct && (await this.firstTime(tx, scope, date, "p", dto.sessionId))) add.productSessions = 1;
      if (sawCart && (await this.firstTime(tx, scope, date, "c", dto.sessionId))) add.cartSessions = 1;
      if (sawCheckout && (await this.firstTime(tx, scope, date, "k", dto.sessionId))) add.checkoutSessions = 1;
      if (sawOrder && (await this.firstTime(tx, scope, date, "o", dto.sessionId))) add.orderSessions = 1;
      const first = dto.events[0];
      const wantCountry = newSession ? (first.country ?? "").trim() : "";

      // one row per scope per day; lock it while merging the counters
      await tx.analyticsDay.createMany({ data: [{ scope, date }], skipDuplicates: true });
      const [row] = await tx.$queryRaw<{ sources: Counts; devices: Counts; countries: Counts; pages: Counts; products: Counts }[]>`
        SELECT "sources", "devices", "countries", "pages", "products" FROM "AnalyticsDay" WHERE "scope" = ${scope} AND "date" = ${date} FOR UPDATE`;
      const merge = (base: Counts, extra: Counts) => { const o = { ...base }; for (const [k, v] of Object.entries(extra)) bump(o, k, v); return o; };
      if (newSession) {
        bump(sources, (SOURCES as readonly string[]).includes(first.source ?? "") ? first.source! : "other");
        bump(devices, (DEVICES as readonly string[]).includes(first.device ?? "") ? first.device! : "desktop");
        const clean = /^[\p{L} .'-]{2,40}$/u.test(wantCountry) ? wantCountry : "Other";
        bump(countries, clean in row.countries || Object.keys(row.countries).length < MAX_COUNTRY_KEYS ? clean : "Other");
      }
      await tx.analyticsDay.update({
        where: { scope_date: { scope, date } },
        data: {
          visitors: { increment: add.visitors }, sessions: { increment: add.sessions }, pageViews: { increment: add.pageViews },
          productViews: { increment: add.productViews }, addToCart: { increment: add.addToCart }, checkouts: { increment: add.checkouts },
          productSessions: { increment: add.productSessions }, cartSessions: { increment: add.cartSessions }, checkoutSessions: { increment: add.checkoutSessions }, orderSessions: { increment: add.orderSessions },
          sources: merge(row.sources, sources), devices: merge(row.devices, devices), countries: merge(row.countries, countries),
          pages: merge(row.pages, pages), products: merge(row.products, products),
        },
      });
    });

    // the dedupe markers only matter for today; tidy up now and then
    if (Math.random() < 0.01) await this.prisma.analyticsSeen.deleteMany({ where: { date: { lt: new Date(date.getTime() - 2 * 86_400_000) } } }).catch(() => undefined);
  }
}
