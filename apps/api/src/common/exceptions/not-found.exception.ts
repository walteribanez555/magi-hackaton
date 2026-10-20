import { HttpException } from './http.exception';

export class NotFoundException extends HttpException {
  constructor(message = 'Not Found', code?: string, details?: unknown) {
    super(404, message, code, details);
  }
}
