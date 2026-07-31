export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg, code = 'bad_request') => new HttpError(400, code, msg);
export const unauthorized = (msg = 'invalid credentials') => new HttpError(401, 'unauthorized', msg);
export const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);
export const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);
export const rangeNotSatisfiable = (msg, code = 'range_required') => new HttpError(416, code, msg);
export const tooManyRequests = (msg = 'rate limit exceeded') => new HttpError(429, 'rate_limited', msg);
export const upstream = (msg = 'upstream error', code = 'upstream') => new HttpError(502, code, msg);
export const timeout = (msg = 'timeout') => new HttpError(504, 'timeout', msg);
