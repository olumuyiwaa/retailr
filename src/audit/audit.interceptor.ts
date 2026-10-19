import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable, tap } from "rxjs";
import { AuditService } from "./audit.service";

/** Successful changes to these areas are written to the audit log. Reads and storefront traffic aren't. */
const AUDITED = [/^platform\//, /^business\/(coupons|team|billing|profile|groups)(\/|$)/];
/** Body fields that are never recorded, even by name. */
const HIDDEN = /pass|token|secret|card|authorization/i;

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next.handle();
    const route: string = String(req.route?.path ?? "").replace(/^\/?(api\/v1\/)?/, "");
    if (!AUDITED.some((r) => r.test(route))) return next.handle();
    return next.handle().pipe(tap(() => {
      const u = req.user as { userId: string; role: string; businessId?: string } | undefined;
      if (!u) return;
      const params = req.params ?? {};
      const fields = Object.keys(req.body ?? {}).filter((k) => !HIDDEN.test(k));
      const body = req.body ?? {};
      void this.audit.record({
        action: `${req.method} ${route}`, actorRole: u.role, actorId: u.userId, actorEmail: req.user?.email ?? null,
        businessId: u.businessId ?? (params.id && route.startsWith("platform/businesses/") ? params.id : null),
        targetId: params.id ?? params.reference ?? null,
        // the shape of the change, never raw values for anything that looks secret: simple scalars only
        meta: { fields, ...Object.fromEntries(fields.filter((k) => ["string", "number", "boolean"].includes(typeof body[k]) && String(body[k]).length <= 80).map((k) => [k, body[k]])) },
      });
    }));
  }
}
