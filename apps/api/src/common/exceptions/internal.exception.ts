import { HttpException } from './http.exception';

export class InternalException extends HttpException {
  constructor(message = 'Internal Server Error', code?: string, details?: unknown) {
    super(500, message, code, details);
  }
}
