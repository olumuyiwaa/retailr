import { Module } from "@nestjs/common";
import { OrderEngine } from "./order-engine.service";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({ controllers: [OrdersController], providers: [OrderEngine, OrdersService], exports: [OrderEngine] })
export class OrdersModule {}
