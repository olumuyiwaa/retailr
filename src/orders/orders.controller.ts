import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { AuthContext, CurrentUser, Roles } from "../common/decorators";
import { ListCustomersQuery, ListOrdersQuery, RecordSaleDto, UpdateOrderStatusDto } from "./dto/orders.dto";
import { OrdersService } from "./orders.service";

const withTotal = (res: Response, total: number) => {
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
};

@ApiTags("orders")
@ApiBearerAuth()
@Roles("BUSINESS_ADMIN")
@Controller("business")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get("orders")
  async list(@CurrentUser() u: AuthContext, @Query() q: ListOrdersQuery, @Res({ passthrough: true }) res: Response) {
    const { items, total } = await this.orders.list(u.businessId!, q);
    withTotal(res, total);
    return items;
  }
  @Get("orders/:id") get(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.orders.get(u.businessId!, id); }
  @Patch("orders/:id/status") status(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() dto: UpdateOrderStatusDto) { return this.orders.setStatus(u.businessId!, id, dto.status); }
  @HttpCode(200) @Post("orders/:id/receipt") receipt(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.orders.markReceiptSent(u.businessId!, id); }
  @Post("sales") sale(@CurrentUser() u: AuthContext, @Body() dto: RecordSaleDto) { return this.orders.recordSale(u.businessId!, dto); }

  @Get("customers")
  async customers(@CurrentUser() u: AuthContext, @Query() q: ListCustomersQuery, @Res({ passthrough: true }) res: Response) {
    const { items, total } = await this.orders.customers(u.businessId!, q);
    withTotal(res, total);
    return items;
  }
  @Get("customers/:id") customer(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.orders.customerDetail(u.businessId!, id); }
}
