import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import type { Response } from "express";

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
export const pageArgs = (q: PageQuery) => { const limit = q.limit ?? 50; return { take: limit, skip: ((q.page ?? 1) - 1) * limit }; };
/** The page is the response body; the total across all pages travels in X-Total-Count. */
export const withTotal = (res: Response, total: number) => {
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
};
