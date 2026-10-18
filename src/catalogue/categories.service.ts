import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppError } from "../common/errors";
import { toCategory } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

const cleanName = (raw: string): string => {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw AppError.badRequest("Enter a category name.");
  if (name.length > 40) throw AppError.badRequest("Keep category names under 40 characters.");
  return name;
};
const clash = (name: string) => AppError.conflict(`You already have a category called "${name}".`, "CATEGORY_EXISTS");
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  private image(businessId: string, url: string) {
    if (!this.storage.isOwnedUrl(businessId, url)) throw AppError.badRequest("Upload the picture again, then save.", "IMAGE_NOT_OWNED");
    return url;
  }

  async list(businessId: string) {
    const rows = await this.prisma.forBusiness(businessId).category.findMany({ include: { _count: { select: { products: true } } } });
    return rows.sort((a, b) => a.name.localeCompare(b.name)).map(toCategory);
  }

  async create(businessId: string, rawName: string, image?: string) {
    const name = cleanName(rawName);
    const db = this.prisma.forBusiness(businessId);
    if (await db.category.findFirst({ where: { name: { equals: name, mode: "insensitive" } } })) throw clash(name);
    try {
      return toCategory(await db.category.create({ data: { name, imageUrl: image ? this.image(businessId, image) : null } as never }));
    } catch (e) {
      if (isUniqueViolation(e)) throw clash(name);
      throw e;
    }
  }

  /** Renaming keeps its products attached (they point at the category, not its name). `image`: URL to set, null to remove, undefined to keep. */
  async update(businessId: string, id: string, patch: { name?: string; image?: string | null }) {
    const db = this.prisma.forBusiness(businessId);
    const cat = await db.category.findUnique({ where: { id } });
    if (!cat) throw AppError.notFound("Category not found.");
    const data: Prisma.CategoryUpdateInput = {};
    if (patch.name !== undefined) {
      const name = cleanName(patch.name);
      if (await db.category.findFirst({ where: { id: { not: id }, name: { equals: name, mode: "insensitive" } } })) throw clash(name);
      data.name = name;
    }
    if (patch.image === null) data.imageUrl = null;
    else if (patch.image) data.imageUrl = this.image(businessId, patch.image);
    try {
      return toCategory(await db.category.update({ where: { id }, data }));
    } catch (e) {
      if (isUniqueViolation(e)) throw clash(String(data.name));
      throw e;
    }
  }

  /** Products in a deleted category stay on sale, just uncategorised. */
  async remove(businessId: string, id: string) {
    const db = this.prisma.forBusiness(businessId);
    const cat = await db.category.findUnique({ where: { id }, include: { _count: { select: { products: true } } } });
    if (!cat) throw AppError.notFound("Category not found.");
    await db.category.delete({ where: { id } });
    return { uncategorised: cat._count.products };
  }
}
