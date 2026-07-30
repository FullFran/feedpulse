# ADR 0005 — One flat error envelope for every failing request

**Status:** accepted · **Applies to:** `src/shared/filters/all-exceptions.filter.ts`

## Context

Failures reach the HTTP edge from four different places, and each has its own natural shape:

1. Nest's own exceptions — `new NotFoundException('feed_not_found')`, which Nest expands to
   `{ statusCode, message: 'feed_not_found', error: 'Not Found' }`.
2. `class-validator` failures raised by the global `ValidationPipe`, which carry an array of
   messages.
3. Express middleware that runs **outside** Nest's exception classes: `body-parser` raising
   `PayloadTooLargeError` when a body exceeds the 256 KiB limit, `raw-body` raising a 400 on
   a malformed charset, multer's upload limits.
4. Anything unexpected — a `TypeError`, a `pg` error.

Left alone, group 3 was flattened to `500 internal_server_error`: a client that sent an
oversized body was told the server had broken. Group 4 leaked class names, and in
non-production Express' `finalhandler` rendered an HTML page containing a stack trace.

## Decision

A single `@Catch()` filter registered as `APP_FILTER`, producing one flat shape for every
failing request:

```json
{
  "statusCode": 401,
  "code": "auth_required",
  "message": "auth_required",
  "timestamp": "2026-07-30T14:12:30.021Z",
  "path": "/api/v1/feeds",
  "requestId": "fb412cee-427b-40c6-a8dd-3209e4d77c44"
}
```

Three rules make it work across all four sources:

- **`code` is derived, never invented.** An explicit `code` in the payload wins; otherwise a
  `snake_case` `message` is promoted (which is exactly how the codebase throws:
  `new NotFoundException('feed_not_found')`); otherwise a `snake_case` `error`; otherwise a
  default per status. `code` is the field clients branch on; `message` is for humans.
- **`http-errors` are recognised.** Any non-`HttpException` `Error` carrying `expose === true`
  and a 4xx status — the library's own marker that the status and message are safe to
  return — is honoured instead of being flattened to 500.
- **5xx never leaks.** Internal class names, stack traces and driver messages are logged
  server-side and replaced with `internal_server_error` on the wire.

Authentication is a global `AuthGuard` rather than Express middleware specifically so that a
401 flows through this filter as JSON, instead of being rendered by `finalhandler` as HTML.

## Consequences

**Good.** Clients parse one shape. `requestId` ties every failure to its log line and is
also on the response header. Adding a new error means throwing with a `snake_case` code —
no filter change.

**Bad.** The envelope carries no field-level detail. A validation failure says
`rule_keyword_too_long`, not _which_ keyword. That is a real cost for form-driven clients,
and closing it means either a `details` object or per-field codes.

## Explicitly rejected: a second envelope

A separate, richer envelope for validation errors — a nested `error` object with a
`details` map, alongside the flat one for everything else — was considered and **rejected**.

Two shapes means every client writes a branch, and the branch is on the very path where the
client is least able to tell which shape it will get: the same endpoint can answer a
`class-validator` failure, a `body-parser` 413 and a repository 409. A client that handles
only one shape would silently mishandle the others.

The upgrade path, if field-level detail is needed, is to add an **optional** `details`
object to the existing envelope. That is additive, keeps one shape, and does not break a
client that ignores it. It is not implemented today.
