import { HttpException } from './http.exception';

export class ConflictException extends HttpException {
  constructor(message = 'Conflict', code?: string, details?: unknown) {
    super(409, message, code, details);
  }
}
