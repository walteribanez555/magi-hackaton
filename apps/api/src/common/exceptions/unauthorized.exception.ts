import { HttpException } from './http.exception';

export class UnauthorizedException extends HttpException {
  constructor(message = 'Unauthorized', code?: string, details?: unknown) {
    super(401, message, code, details);
  }
}
