import { HttpException } from './http.exception';

export class ForbiddenException extends HttpException {
  constructor(message = 'Forbidden', code?: string, details?: unknown) {
    super(403, message, code, details);
  }
}
