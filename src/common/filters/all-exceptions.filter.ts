import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Response } from "express";

const CODES: Record<number, string> = {
  400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 422: "UNPROCESSABLE", 429: "RATE_LIMITED",
};

/** Every error leaves the API as { statusCode, code, message }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger("Errors");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "Something went wrong. Please try again.";

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      code = CODES[statusCode] ?? "ERROR";
      if (typeof body === "string") message = body;
      else if (body && typeof body === "object") {
        const b = body as { code?: string; message?: string | string[] };
        code = b.code ?? CODES[statusCode] ?? "ERROR";
        message = Array.isArray(b.message) ? b.message[0] : b.message ?? message;
      }
      if (statusCode === 429) message = "Too many requests. Please wait a moment and try again.";
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === "P2002") { statusCode = 409; code = "CONFLICT"; message = "That already exists."; }
      else if (exception.code === "P2025") { statusCode = 404; code = "NOT_FOUND"; message = "Not found."; }
      else this.log.error(exception);
    } else {
      this.log.error(exception instanceof Error ? exception.stack : String(exception));
    }
    res.status(statusCode).json({ statusCode, code, message });
  }
}
