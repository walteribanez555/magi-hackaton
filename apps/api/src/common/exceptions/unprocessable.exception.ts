import { HttpException } from './http.exception';

export class UnprocessableException extends HttpException {
  constructor(message = 'Unprocessable Entity', code?: string, details?: unknown) {
    super(422, message, code, details);
  }
}
