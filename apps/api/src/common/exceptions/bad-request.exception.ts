import { HttpException } from './http.exception';

export class BadRequestException extends HttpException {
  constructor(message = 'Bad Request', code?: string, details?: unknown) {
    super(400, message, code, details);
  }
}
