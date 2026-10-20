export class HttpException extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
    /** detalle extra que viaja en `details` (p. ej. issues de zod) */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
