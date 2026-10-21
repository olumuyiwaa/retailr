import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";
import { AuthContext, CurrentUser, Roles } from "../common/decorators";
import { SearchService } from "./search.service";

class SearchQuery {
  @IsOptional() @IsString() q?: string;
}

@ApiTags("search")
@ApiBearerAuth()
@Roles("BUSINESS_ADMIN")
@Controller("business")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /** The top few orders, customers and products/services matching `q`. */
  @Get("search") run(@CurrentUser() u: AuthContext, @Query() q: SearchQuery) { return this.search.search(u.businessId!, q.q ?? ""); }
}
