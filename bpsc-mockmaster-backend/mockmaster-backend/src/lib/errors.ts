/** Errors carry a stable code and a human-readable message. Internal details never reach the client. */
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}
export const badRequest = (code: string, msg: string, details?: Record<string, unknown>) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Please sign in to continue.') => new AppError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (msg = 'You do not have permission to do this.') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (what = 'Item') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (code: string, msg: string, details?: Record<string, unknown>) => new AppError(409, code, msg, details);
export const tooMany = (retryAfterSec: number) => new AppError(429, 'RATE_LIMITED', `Too many requests. Please try again in ${retryAfterSec} seconds.`, { retryAfterSec });
