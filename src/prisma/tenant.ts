import { Prisma } from "@prisma/client";

/**
 * Models that carry a businessId. Child tables (ProductImage, ProductVariant, OrderItem,
 * CustomerGroupMember) have no businessId and must only be reached through their parent.
 */
const TENANT_MODELS = new Set(["TeamMember", "Subscription", "Invoice", "Category", "Product", "Customer", "CustomerGroup", "Order", "Coupon", "Message", "Booking"]);

const WHERE_OPS = new Set([
  "findFirst", "findFirstOrThrow", "findMany", "findUnique", "findUniqueOrThrow", "count", "aggregate", "groupBy",
  "update", "updateMany", "delete", "deleteMany", "upsert",
]);

/**
 * Prisma extension that scopes every query on a tenant model to one business:
 * reads, updates and deletes get `businessId` added to their `where`, creates get it stamped on
 * `data`, and a create that tries to name a different business is rejected. Services for a business
 * admin should only ever use `prisma.forBusiness(id)`, so a forgotten filter can't leak another tenant's rows.
 */
export function tenantExtension(businessId: string) {
  if (!businessId) throw new Error("forBusiness() needs a businessId");
  return Prisma.defineExtension({
    name: `tenant:${businessId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_MODELS.has(model)) return query(args);
          const a = (args ?? {}) as Record<string, any>;
          if (WHERE_OPS.has(operation)) a.where = { ...(a.where ?? {}), businessId };
          if (operation === "create") a.data = stamp(a.data, businessId);
          if (operation === "createMany" || operation === "createManyAndReturn") {
            a.data = (Array.isArray(a.data) ? a.data : [a.data]).map((d: unknown) => stamp(d, businessId));
          }
          if (operation === "upsert") a.create = stamp(a.create, businessId);
          if (operation === "update" || operation === "updateMany") {
            if (a.data && "businessId" in a.data) throw new Error("A row can't be moved to another business.");
          }
          return query(a as never);
        },
      },
    },
  });
}

function stamp(data: any, businessId: string) {
  const other = data?.businessId ?? data?.business?.connect?.id;
  if (other !== undefined && other !== businessId) throw new Error("Cross-tenant write blocked.");
  // relation-style create (business: { connect }) already names the business; scalar style gets stamped
  if (data?.business) return data;
  return { ...data, businessId };
}
