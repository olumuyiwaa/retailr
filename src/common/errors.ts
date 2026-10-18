import { HttpException } from "@nestjs/common";

/** An error the UI can show as-is: `message` is user-facing, `code` is for programmatic handling. */
export class AppError extends HttpException {
  constructor(status: number, public readonly code: string, message: string) {
    super({ statusCode: status, code, message }, status);
  }
  static badRequest(message: string, code = "BAD_REQUEST") { return new AppError(400, code, message); }
  static unauthorized(message = "Please sign in again.", code = "UNAUTHORIZED") { return new AppError(401, code, message); }
  static forbidden(message: string, code = "FORBIDDEN") { return new AppError(403, code, message); }
  static notFound(message: string, code = "NOT_FOUND") { return new AppError(404, code, message); }
  static conflict(message: string, code = "CONFLICT") { return new AppError(409, code, message); }
}
