import { HttpException } from './http.exception';

export class BadGatewayException extends HttpException {
  constructor(message = 'Bad Gateway', code?: string, details?: unknown) {
    super(502, message, code, details);
  }
}
