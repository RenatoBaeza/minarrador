// A caught value is `unknown` — a rejected promise or a `throw` can carry
// anything — but nearly every place that catches one only wants to log or show
// its message. These are the shapes that asks for, in one place.

/** The message of whatever was thrown, whether or not it was an Error. */
export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);

/** The `code` a Node system error carries (ENOENT, EBUSY…), or ''. */
export const errorCode = (err: unknown): string =>
  err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' ? err.code : '';

/** The `name` of whatever was thrown — AbortError, TimeoutError — or ''. */
export const errorName = (err: unknown): string =>
  err && typeof err === 'object' && 'name' in err && typeof err.name === 'string' ? err.name : '';
