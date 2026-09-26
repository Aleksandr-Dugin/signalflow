// Lightweight error helpers shared across the stack.

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Forbidden", code?: string) {
    super(403, message, code);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = "Unauthorized", code?: string) {
    super(401, message, code);
    this.name = "UnauthorizedError";
  }
}
