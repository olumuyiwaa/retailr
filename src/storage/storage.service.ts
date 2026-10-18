import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { AppError } from "../common/errors";

export const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
export type UploadKind = "product" | "category" | "logo";

export interface UploadTicket {
  method: "PUT";
  /** Send the file bytes here with the headers below. */
  uploadUrl: string;
  headers: Record<string, string>;
  /** Store this URL on the product, category or business once the upload succeeds. */
  publicUrl: string;
  maxBytes: number;
  expiresInSeconds: number;
}

const TTL_SECONDS = 300;

/** Signs short-lived upload URLs and decides which stored URLs a business may attach to its records. */
@Injectable()
export class StorageService {
  private readonly driver: string;
  private readonly maxBytes: number;
  private readonly apiUrl: string;
  readonly publicBase: string;
  private readonly secret: string;
  private s3?: S3Client;
  private readonly bucket?: string;

  constructor(private readonly config: ConfigService) {
    this.driver = config.get("STORAGE_DRIVER") ?? "local";
    this.maxBytes = config.get<number>("UPLOAD_MAX_BYTES") ?? 2_097_152;
    this.apiUrl = (config.get<string>("API_PUBLIC_URL") ?? "http://localhost:4000").replace(/\/$/, "");
    this.publicBase = (config.get<string>("STORAGE_PUBLIC_URL") ?? `${this.apiUrl}/files`).replace(/\/$/, "");
    this.secret = config.getOrThrow("JWT_ACCESS_SECRET");
    if (this.driver === "s3") {
      this.bucket = config.getOrThrow("S3_BUCKET");
      this.s3 = new S3Client({
        region: config.getOrThrow("S3_REGION"),
        endpoint: config.get("S3_ENDPOINT") || undefined,
        forcePathStyle: !!config.get("S3_ENDPOINT"),
        credentials: { accessKeyId: config.getOrThrow("S3_ACCESS_KEY_ID"), secretAccessKey: config.getOrThrow("S3_SECRET_ACCESS_KEY") },
      });
    }
  }

  async createUpload(businessId: string, kind: UploadKind, contentType: string, size: number): Promise<UploadTicket> {
    const ext = IMAGE_TYPES[contentType];
    if (!ext) throw AppError.badRequest("Upload a JPG, PNG, WebP or GIF image.", "UPLOAD_TYPE");
    if (!(size > 0) || size > this.maxBytes) throw AppError.badRequest(`Images can be up to ${Math.round(this.maxBytes / 1_048_576 * 10) / 10} MB.`, "UPLOAD_TOO_LARGE");

    // the key starts with the business id: that is what ties a stored file to its owner
    const key = `${businessId}/${kind}/${randomBytes(12).toString("hex")}.${ext}`;
    const publicUrl = `${this.publicBase}/${key}`;
    const base = { method: "PUT" as const, publicUrl, maxBytes: this.maxBytes, expiresInSeconds: TTL_SECONDS };

    if (this.driver === "s3") {
      const uploadUrl = await getSignedUrl(
        this.s3!,
        new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size, CacheControl: "public, max-age=31536000, immutable" }),
        { expiresIn: TTL_SECONDS },
      );
      return { ...base, uploadUrl, headers: { "Content-Type": contentType } };
    }
    const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const sig = this.sign(key, contentType, exp);
    const uploadUrl = `${this.apiUrl}/api/v1/uploads/local/${key}?exp=${exp}&type=${encodeURIComponent(contentType)}&sig=${sig}`;
    return { ...base, uploadUrl, headers: { "Content-Type": contentType } };
  }

  /** Checks the signature on a local-driver upload URL. */
  verifyLocal(key: string, contentType: string, exp: number, sig: string): boolean {
    if (!(exp > Date.now() / 1000)) return false;
    const want = Buffer.from(this.sign(key, contentType, exp));
    const got = Buffer.from(sig ?? "");
    return want.length === got.length && timingSafeEqual(want, got);
  }

  get maxUploadBytes() { return this.maxBytes; }
  get isLocal() { return this.driver === "local"; }

  /** True when `url` is a file this business uploaded. Anything else (other tenants' files, data URLs, random hosts) is refused. */
  isOwnedUrl(businessId: string, url: string): boolean {
    const prefix = `${this.publicBase}/${businessId}/`;
    return url.startsWith(prefix) && !url.slice(prefix.length).includes("..") && !/[?#\s]/.test(url);
  }

  private sign(key: string, contentType: string, exp: number) {
    return createHmac("sha256", this.secret).update(`${key}\n${contentType}\n${exp}`).digest("hex");
  }
}
