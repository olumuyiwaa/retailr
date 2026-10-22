import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppError } from "../common/errors";
import { toService } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ListServicesQuery, ServiceDto } from "./dto/catalogue.dto";
import { cleanSpecs, MAX_PRODUCT_IMAGES } from "./products.service";

const COLORS = ["#c3ceff", "#ffd9a8", "#b7ebd0", "#fecdca", "#d9d6fe", "#b2e9f5"];
const include = { category: true, images: { orderBy: { position: "asc" } }, options: { orderBy: { position: "asc" } } } satisfies Prisma.ServiceInclude;

function cleanOptions(input: ServiceDto["options"]) {
  if (!input?.length) return [];
  const seen = new Set<string>();
  return input.map((v, position) => {
    const name = v.name.trim();
    if (!name) throw AppError.badRequest("Every option needs a name.");
    if (seen.has(name.toLowerCase())) throw AppError.badRequest(`Two options are both called "${name}".`);
    seen.add(name.toLowerCase());
    if (v.price !== undefined && v.price !== null && !(v.price >= 0)) throw AppError.badRequest(`Enter a valid price for "${name}".`);
    return { id: v.id, name, price: v.price ?? null, position };
  });
}

/** Services: priced by the job, optionally bookable for a time slot. No stock. */
@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  async list(businessId: string, q: ListServicesQuery) {
    const where: Prisma.ServiceWhereInput = {
      ...(q.status ? { status: q.status.toUpperCase() as never } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.q?.trim() ? { name: { contains: q.q.trim(), mode: "insensitive" } } : {}),
    };
    const limit = q.limit ?? 100;
    const db = this.prisma.forBusiness(businessId);
    const [rows, total] = await Promise.all([
      db.service.findMany({ where, include, orderBy: { createdAt: "desc" }, skip: ((q.page ?? 1) - 1) * limit, take: limit }),
      db.service.count({ where }),
    ]);
    return { items: rows.map(toService), total };
  }

  async get(businessId: string, id: string) {
    const s = await this.prisma.forBusiness(businessId).service.findUnique({ where: { id }, include });
    if (!s) throw AppError.notFound("Service not found.");
    return toService(s);
  }

  async create(businessId: string, dto: ServiceDto) {
    const f = await this.prepare(businessId, dto);
    const id = await this.prisma.forBusiness(businessId).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId}))`;
      const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: { plan: true } });
      const count = (await tx.service.count()) + (await tx.product.count());
      if (biz.plan.maxProducts !== -1 && count >= biz.plan.maxProducts) {
        throw AppError.forbidden(`Your ${biz.plan.name} plan is limited to ${biz.plan.maxProducts} products and services. Upgrade to add more.`, "PLAN_LIMIT_PRODUCTS");
      }
      const s = await tx.service.create({
        data: {
          ...f.scalars, imageColor: COLORS[count % COLORS.length],
          ...(f.specs ? { specs: f.specs } : {}),
          images: { create: f.images.map((url, position) => ({ url, position })) },
          options: { create: f.options.map(({ id: _drop, ...o }) => o) },
        } as never,
      });
      return s.id;
    });
    return this.get(businessId, id);
  }

  async update(businessId: string, id: string, dto: ServiceDto) {
    const f = await this.prepare(businessId, dto);
    const db = this.prisma.forBusiness(businessId);
    await db.$transaction(async (tx) => {
      const existing = await tx.service.findUnique({ where: { id }, include: { options: true } });
      if (!existing) throw AppError.notFound("Service not found.");
      // keep the option ids the caller sends (order history points at them), create the rest, drop the missing
      const mine = new Set(existing.options.map((o) => o.id));
      const keep = new Set(f.options.filter((o) => o.id).map((o) => o.id!));
      for (const o of f.options) if (o.id && !mine.has(o.id)) throw AppError.badRequest(`"${o.name}" no longer exists. Reload and try again.`);
      await tx.serviceOption.deleteMany({ where: { serviceId: id, id: { notIn: [...keep] } } });
      for (const o of f.options) {
        const data = { name: o.name, price: o.price, position: o.position };
        if (o.id) await tx.serviceOption.update({ where: { id: o.id }, data });
        else await tx.serviceOption.create({ data: { ...data, serviceId: id } });
      }
      if (f.imagesGiven) {
        await tx.serviceImage.deleteMany({ where: { serviceId: id } });
        await tx.serviceImage.createMany({ data: f.images.map((url, position) => ({ serviceId: id, url, position })) });
      }
      await tx.service.update({ where: { id }, data: { ...f.scalars, ...(f.specs !== undefined ? { specs: f.specs ?? Prisma.DbNull } : {}) } as never });
    }).catch((e) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw AppError.badRequest("Two options have the same name.");
      throw e;
    });
    return this.get(businessId, id);
  }

  /** Orders and bookings keep their own snapshots, so deleting a service never rewrites history. */
  async remove(businessId: string, id: string) {
    const db = this.prisma.forBusiness(businessId);
    if (!(await db.service.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("Service not found.");
    await db.service.delete({ where: { id } });
  }

  private async prepare(businessId: string, dto: ServiceDto) {
    const specs = cleanSpecs(dto.specs);
    const options = cleanOptions(dto.options);
    if (dto.images && dto.images.length > MAX_PRODUCT_IMAGES) throw AppError.badRequest(`A service can have up to ${MAX_PRODUCT_IMAGES} photos.`);
    const images = (dto.images ?? []).filter(Boolean);
    for (const url of images) if (!this.storage.isOwnedUrl(businessId, url)) throw AppError.badRequest("Upload the photo again, then save.", "IMAGE_NOT_OWNED");
    if (dto.bookable && !dto.durationMins) throw AppError.badRequest("Add how long the service takes so customers can pick a time.", "DURATION_REQUIRED");
    const name = dto.name.trim();
    if (!name) throw AppError.badRequest("Enter a service name.");
    let categoryId: string | null = null;
    const wanted = dto.category?.trim();
    if (wanted) {
      const cat = await this.prisma.forBusiness(businessId).category.findFirst({ where: { name: { equals: wanted, mode: "insensitive" } } });
      if (!cat) throw AppError.badRequest(`"${wanted}" isn't one of your categories. Add it under Categories first.`, "CATEGORY_UNKNOWN");
      categoryId = cat.id;
    }
    return {
      scalars: {
        name, bookable: !!dto.bookable, ...(dto.maxConcurrent !== undefined ? { maxConcurrent: dto.maxConcurrent } : {}),
        ...(dto.durationMins !== undefined ? { durationMins: dto.durationMins } : {}),
        description: dto.description?.trim() ?? "", price: dto.price, status: dto.status.toUpperCase(), categoryId,
      },
      specs: dto.specs === undefined ? undefined : specs!.length ? specs : null,
      images, imagesGiven: dto.images !== undefined, options,
    };
  }
}
