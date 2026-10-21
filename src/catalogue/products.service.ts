import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppError } from "../common/errors";
import { toProduct } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ProductDto } from "./dto/catalogue.dto";

export const MAX_PRODUCT_IMAGES = 6;
export const MAX_PRODUCT_SPECS = 10;
const COLORS = ["#c3ceff", "#ffd9a8", "#b7ebd0", "#fecdca", "#d9d6fe", "#b2e9f5"];
const include = { category: true, images: { orderBy: { position: "asc" } }, variants: { orderBy: { position: "asc" } } } satisfies Prisma.ProductInclude;

function cleanSpecs(input?: { label: string; value: string }[]) {
  if (!input) return undefined;
  const rows = input.map((s) => ({ label: s.label.trim(), value: s.value.trim() })).filter((s) => s.label || s.value);
  if (rows.length > MAX_PRODUCT_SPECS) throw AppError.badRequest(`A product can have up to ${MAX_PRODUCT_SPECS} details.`);
  for (const r of rows) {
    if (!r.label || !r.value) throw AppError.badRequest("Each product detail needs both a name and a value.");
    if (r.label.length > 30) throw AppError.badRequest("Keep detail names under 30 characters.");
    if (r.value.length > 120) throw AppError.badRequest("Keep detail values under 120 characters.");
  }
  return rows;
}

function cleanVariants(input: ProductDto["variants"], service: boolean) {
  if (!input?.length) return [];
  const seen = new Set<string>();
  return input.map((v, position) => {
    const name = v.name.trim();
    if (!name) throw AppError.badRequest("Every variant needs a name.");
    if (seen.has(name.toLowerCase())) throw AppError.badRequest(`Two variants are both called "${name}".`);
    seen.add(name.toLowerCase());
    const stock = service ? 0 : v.stock ?? 0;
    if (!Number.isInteger(stock) || stock < 0) throw AppError.badRequest(`Stock for "${name}" must be a whole number, 0 or more.`);
    if (v.price !== undefined && v.price !== null && !(v.price >= 0)) throw AppError.badRequest(`Enter a valid price for "${name}".`);
    return { id: v.id, name, price: v.price ?? null, stock, position };
  });
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  async list(businessId: string, q: { q?: string; kind?: string; status?: string; categoryId?: string; page?: number; limit?: number }) {
    const where: Prisma.ProductWhereInput = {
      ...(q.kind ? { kind: q.kind.toUpperCase() as never } : {}),
      ...(q.status ? { status: q.status.toUpperCase() as never } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.q?.trim() ? { OR: [{ name: { contains: q.q.trim(), mode: "insensitive" } }, { sku: { contains: q.q.trim(), mode: "insensitive" } }] } : {}),
    };
    const limit = q.limit ?? 100;
    const db = this.prisma.forBusiness(businessId);
    const [rows, total] = await Promise.all([
      db.product.findMany({ where, include, orderBy: { createdAt: "desc" }, skip: ((q.page ?? 1) - 1) * limit, take: limit }),
      db.product.count({ where }),
    ]);
    return { items: rows.map(toProduct), total };
  }

  async get(businessId: string, id: string) {
    const p = await this.prisma.forBusiness(businessId).product.findUnique({ where: { id }, include });
    if (!p) throw AppError.notFound("Product not found.");
    return toProduct(p);
  }

  async create(businessId: string, dto: ProductDto) {
    const fields = await this.prepare(businessId, dto);
    const id = await this.prisma.forBusiness(businessId).$transaction(async (tx) => {
      // serialise creates per business so two requests can't both slip under the plan limit
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId}))`;
      const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: { plan: true } });
      const count = await tx.product.count();
      if (biz.plan.maxProducts !== -1 && count >= biz.plan.maxProducts) {
        throw AppError.forbidden(`Your ${biz.plan.name} plan is limited to ${biz.plan.maxProducts} products. Upgrade to add more.`, "PLAN_LIMIT_PRODUCTS");
      }
      const p = await tx.product.create({
        data: {
          ...fields.scalars, imageColor: COLORS[count % COLORS.length],
          ...(fields.specs ? { specs: fields.specs } : {}),
          images: { create: fields.images.map((url, position) => ({ url, position })) },
          variants: { create: fields.variants.map(({ id: _drop, ...v }) => v) },
        } as never,
      });
      return p.id;
    });
    return this.get(businessId, id);
  }

  async update(businessId: string, id: string, dto: ProductDto) {
    const fields = await this.prepare(businessId, dto);
    const db = this.prisma.forBusiness(businessId);
    await db.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({ where: { id }, include: { variants: true } });
      if (!existing) throw AppError.notFound("Product not found.");

      // variants: keep ids the caller sends (order history points at them), create the rest, drop the missing
      const mine = new Set(existing.variants.map((v) => v.id));
      const keep = new Set(fields.variants.filter((v) => v.id).map((v) => v.id!));
      for (const v of fields.variants) if (v.id && !mine.has(v.id)) throw AppError.badRequest(`"${v.name}" no longer exists. Reload and try again.`);
      await tx.productVariant.deleteMany({ where: { productId: id, id: { notIn: [...keep] } } });
      for (const v of fields.variants) {
        const data = { name: v.name, price: v.price, stock: v.stock, position: v.position };
        if (v.id) await tx.productVariant.update({ where: { id: v.id }, data });
        else await tx.productVariant.create({ data: { ...data, productId: id } });
      }

      if (fields.imagesGiven) {
        await tx.productImage.deleteMany({ where: { productId: id } });
        await tx.productImage.createMany({ data: fields.images.map((url, position) => ({ productId: id, url, position })) });
      }
      await tx.product.update({
        where: { id },
        data: { ...fields.scalars, ...(fields.specs !== undefined ? { specs: fields.specs ?? Prisma.DbNull } : {}) } as never,
      });
    }).catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw AppError.badRequest("Two variants have the same name.");
      throw e;
    });
    return this.get(businessId, id);
  }

  /** Order history keeps its own snapshots, so deleting a product never rewrites past orders. */
  async remove(businessId: string, id: string) {
    const db = this.prisma.forBusiness(businessId);
    if (!(await db.product.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("Product not found.");
    await db.product.delete({ where: { id } });
  }

  /** Validates the body and works out what to store. */
  private async prepare(businessId: string, dto: ProductDto) {
    const specs = cleanSpecs(dto.specs);
    const service = dto.kind === "service";
    const variants = cleanVariants(dto.variants, service);
    if (dto.images && dto.images.length > MAX_PRODUCT_IMAGES) throw AppError.badRequest(`A product can have up to ${MAX_PRODUCT_IMAGES} photos.`);
    const images = (dto.images ?? []).filter(Boolean);
    for (const url of images) {
      if (!this.storage.isOwnedUrl(businessId, url)) throw AppError.badRequest("Upload the photo again, then save.", "IMAGE_NOT_OWNED");
    }
    if (service && dto.bookable && !dto.durationMins) throw AppError.badRequest("Add how long the service takes so customers can pick a time.", "DURATION_REQUIRED");
    const given = dto.stock ?? 0;
    if (!service && (!Number.isInteger(given) || given < 0)) throw AppError.badRequest("Stock must be a whole number, 0 or more.");
    const name = dto.name.trim();
    if (!name) throw AppError.badRequest(service ? "Enter a service name." : "Enter a product name.");

    // a product's category is one of the business's own, matched case-insensitively
    let categoryId: string | null = null;
    const wanted = dto.category?.trim();
    if (wanted) {
      const cat = await this.prisma.forBusiness(businessId).category.findFirst({ where: { name: { equals: wanted, mode: "insensitive" } } });
      if (!cat) throw AppError.badRequest(`"${wanted}" isn't one of your categories. Add it under Categories first.`, "CATEGORY_UNKNOWN");
      categoryId = cat.id;
    }

    // a service is never "sold out": no stock, and a stale out-of-stock status becomes active
    const stock = service ? 0 : variants.length ? variants.reduce((s, v) => s + v.stock, 0) : given;
    const status = service ? (dto.status === "draft" ? "DRAFT" : "ACTIVE") : (stock === 0 && dto.status === "active" ? "out_of_stock" : dto.status).toUpperCase();
    return {
      scalars: { name, kind: (service ? "SERVICE" : "PRODUCT") as never, bookable: service && !!dto.bookable, ...(dto.maxConcurrent !== undefined ? { maxConcurrent: dto.maxConcurrent } : {}), ...(service ? (dto.durationMins !== undefined ? { durationMins: dto.durationMins } : {}) : { durationMins: null }), sku: dto.sku?.trim() ?? "", description: dto.description?.trim() ?? "", price: dto.price, stock, status, categoryId },
      specs: dto.specs === undefined ? undefined : specs!.length ? specs : null,
      images,
      imagesGiven: dto.images !== undefined,
      variants,
    };
  }
}
