export class UserError extends Error {
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "UserError";
    this.cause = cause;
  }
}
