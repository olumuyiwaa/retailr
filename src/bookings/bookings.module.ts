import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module";
import { BookingsController, PublicBookingsController } from "./bookings.controller";
import { BookingsService } from "./bookings.service";

@Module({ imports: [OrdersModule], controllers: [BookingsController, PublicBookingsController], providers: [BookingsService] })
export class BookingsModule {}
