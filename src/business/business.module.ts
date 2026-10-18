import { Module } from "@nestjs/common";
import { BusinessController } from "./business.controller";
import { CouponsService } from "./coupons.service";
import { GroupsService } from "./groups.service";
import { MessagesService } from "./messages.service";
import { ProfileService } from "./profile.service";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { TeamService } from "./team.service";

@Module({
  controllers: [BusinessController, ReportsController],
  providers: [CouponsService, GroupsService, MessagesService, TeamService, ProfileService, ReportsService],
  exports: [GroupsService],
})
export class BusinessModule {}
