/** An error whose message is safe to show to the end user. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string) => new AppError(400, 'bad_request', message);
export const unauthorized = (message = 'Faça login para continuar') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Você não tem permissão para isso') =>
  new AppError(403, 'forbidden', message);
export const notFound = (message = 'Não encontrado') => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const tooManyRequests = () =>
  new AppError(429, 'rate_limited', 'Muitas tentativas. Aguarde um minuto e tente de novo.');
