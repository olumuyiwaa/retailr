import { Body, Controller, HttpCode, Param, Post, Put, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsIn, IsInt, IsString, Max, Min } from "class-validator";
import { ConfigService } from "@nestjs/config";
import { createWriteStream } from "fs";
import { mkdir, rm } from "fs/promises";
import { dirname, resolve, sep } from "path";
import type { Request } from "express";
import { AuthContext, CurrentUser, Public, Roles } from "../common/decorators";
import { AppError } from "../common/errors";
import { StorageService, UploadKind } from "./storage.service";

class CreateUploadDto {
  @IsIn(["product", "category", "logo"]) kind: UploadKind;
  @IsString() contentType: string;
  @IsInt() @Min(1) @Max(50_000_000) size: number;
}

@ApiTags("uploads")
@Controller()
export class UploadsController {
  constructor(private readonly storage: StorageService, private readonly config: ConfigService) {}

  /** Step 1: ask for an upload URL. Step 2: PUT the file bytes there. Step 3: save `publicUrl` on the record. */
  @ApiBearerAuth()
  @Roles("BUSINESS_ADMIN")
  @HttpCode(200)
  @Post("business/uploads")
  create(@CurrentUser() user: AuthContext, @Body() dto: CreateUploadDto) {
    return this.storage.createUpload(user.businessId!, dto.kind, dto.contentType, dto.size);
  }

  /** Receives the file for the local (development) storage driver. Not used with s3. */
  @Public()
  @HttpCode(200)
  @Put("uploads/local/:businessId/:kind/:file")
  async putLocal(
    @Param("businessId") businessId: string, @Param("kind") kind: string, @Param("file") file: string,
    @Query("exp") exp: string, @Query("type") type: string, @Query("sig") sig: string, @Req() req: Request,
  ) {
    if (!this.storage.isLocal) throw AppError.notFound("Not found.");
    const key = `${businessId}/${kind}/${file}`;
    if (!/^[a-z0-9]+\/(product|category|logo)\/[a-f0-9]{24}\.(jpg|png|webp|gif)$/.test(key)) throw AppError.badRequest("Invalid upload.");
    if (!this.storage.verifyLocal(key, type, Number(exp), sig)) throw AppError.forbidden("This upload link is invalid or has expired.", "UPLOAD_LINK_INVALID");
    if (req.headers["content-type"] !== type) throw AppError.badRequest("Wrong content type.", "UPLOAD_TYPE");

    const root = resolve(this.config.get<string>("LOCAL_UPLOAD_DIR") ?? "./uploads");
    const target = resolve(root, key);
    if (!target.startsWith(root + sep)) throw AppError.badRequest("Invalid upload.");
    await mkdir(dirname(target), { recursive: true });

    const max = this.storage.maxUploadBytes;
    let received = 0;
    await new Promise<void>((done, fail) => {
      const out = createWriteStream(target);
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > max) { req.unpipe(out); out.destroy(); fail(AppError.badRequest("That image is too large.", "UPLOAD_TOO_LARGE")); }
      });
      req.pipe(out);
      out.on("finish", done);
      out.on("error", fail);
      req.on("error", fail);
    }).catch(async (e) => { await rm(target, { force: true }); throw e; });
    return { ok: true };
  }
}
