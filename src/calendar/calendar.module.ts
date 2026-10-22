import { Module } from "@nestjs/common";
import { CalendarController, CalendarFeedController } from "./calendar.controller";
import { CalendarService } from "./calendar.service";

@Module({ controllers: [CalendarController, CalendarFeedController], providers: [CalendarService] })
export class CalendarModule {}
