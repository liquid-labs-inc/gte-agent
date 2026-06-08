# Milestone 3: GTE Auth And Session Authority

This document is the source-of-truth plan for Milestone 3 of the GTE Agent retrofit.

Milestone 3 defines the first real GTE boundary: authenticated requests, one immutable trading authority per session, and authorization checks that future tools must derive from. It should not implement trading tools or production persistence.

Milestone 3 is documentation for future implementation. It is part of the same pre-MVP hardening chain as Milestone 2, with no separate migration compatibility burden for old OpenCode, V1, workspace, share, or account data.

## Goal

Add a GTE auth and session authority contract to the canonical runtime.

The runtime should authenticate requests through GTE bearer-token validation or introspection, bind every session to an authenticated principal and one explicitly selected GTE trading authority, and enforce read/mutation access on canonical session surfaces.

## End State

After Milestone 3:

- Every session has a stored `principalID` and `authorityID`.
- `principalID` identifies who authenticated.
- `authorityID` is the opaque GTE trading authority the session is bound to.
- Session creation in auth-enabled mode requires explicit `authorityID` selection in the request body.
- Auth-disabled dev/test mode remains easy to use, but it still inserts a synthetic dev principal and authority so the session invariant is universal.
- A session's `authorityID` is immutable. Changing authority requires creating a new session.
- Every request that reads or mutates session state verifies that the current authenticated principal is allowed to access the session and act for, or read from, the bound authority according to GTE policy.
- Read and mutation capabilities are modeled separately. Losing trading authority blocks mutation immediately; historical read access depends on explicit GTE policy.
- Bearer tokens never silently select an authority server-side, even when the token is valid for exactly one trading authority.
- A standard authority header convention exists for future non-session endpoints that need transient authority context, but it is implemented only if such endpoints exist in this milestone.
- Inherited OpenCode account/org/device-login tables and flows are removed from active packages.
- A small GTE auth/authority module replaces inherited account/org state.
- Local SQLite simulates the auth/authority contract for development and tests.
- Production GTE/server-side persistence remains an explicit later milestone TODO.
- Legacy OpenCode routes are removed or unreachable before this milestone. Milestone 3 secures canonical GTE Agent routes only; it does not add compatibility auth for legacy session routes.

## Concepts

### Principal

`principalID` means who authenticated.

Example:

```ts
principalID = "user_moses"
```

It answers: which human, application, or service made this request?

### Authority

`authorityID` means which GTE trading authority this session may act under.

Example:

```ts
authorityID = "ta_fund_subaccount_7"
```

It may later represent a user trading authority, subaccount, wallet, portfolio, venue account, or entitlement scope. Milestone 3 should persist it as an opaque identifier and store optional decoded metadata only for display/debug.

### Session Binding

When a principal creates a session for an authority, the session stores both:

```ts
sessionID = "ses_..."
principalID = "user_moses"
authorityID = "ta_fund_subaccount_7"
```

Later requests must prove the current principal can still read the session and, for mutations, act for the bound authority.

## Auth Boundary

Start with GTE bearer-token validation or introspection at the server boundary.

Interactive login UX is not required in Milestone 3. CLI/TUI login flows can be added later once GTE's login protocol and product UX are defined.

The auth layer should produce an authenticated request context containing:

- `principalID`.
- The authorities the principal may access, or enough token/introspection data to check authority access.
- Optional principal/authority metadata for logs, display, and debugging.

Define a small GTE auth/authority service boundary instead of embedding policy checks ad hoc:

- Auth validates or introspects GTE bearer tokens and returns request principal context.
- Authority policy checks whether that principal can read a session and whether that principal can currently act for an authority.
- Session code stores `principalID` and `authorityID`, but it never derives session authority from request headers after creation.
- Denied reads, denied mutations, missing bearer credentials, invalid bearer credentials, and authority mismatch conflicts should have explicit error types and HTTP mappings.

Local daemon HTTP credentials, if still needed for local process discovery, are transport credentials only. They do not produce `principalID`, do not imply GTE product auth, and do not authorize authority access.

Do not overload `event_sequence.owner_id` for auth. That field is not product auth, session ownership, authority scoping, tenant state, or a reason to reintroduce sync semantics.

## Session Authorization

Session creation:

- Auth-enabled mode always requires `authorityID` in the request body, even when the bearer token has exactly one authority.
- Auth-disabled dev/test mode fills synthetic values.
- The new session stores `principalID` and immutable `authorityID`.
- Reusing a session ID is an exact retry only when the existing stored `principalID` and `authorityID` match the authenticated request and requested authority. A mismatched principal or authority is a conflict.

Session reads:

- Check that the authenticated principal has read access to the session according to GTE policy.
- Read access and act/trade access are separate capabilities.

Session mutations:

- Check that the authenticated principal can currently act for the session's bound authority.
- Prompt admission is a mutation and must be checked.
- Future tool execution must derive authority from the session, not from ad hoc request fields.

Canonical surfaces to guard:

- `POST /api/session`: product bearer auth required in auth-enabled mode; explicit body `authorityID`; conflict on mismatched reused session ID, principal, or authority.
- `GET /api/session`: list only sessions readable by the current principal.
- `GET /api/session/:sessionID/context`: read surface; deny unauthorized sessions.
- `GET /api/session/:sessionID/message`: read surface; deny unauthorized sessions.
- `POST /api/session/:sessionID/prompt`: mutation; require current act access for the bound authority.
- `POST /api/session/:sessionID/compact`: mutation; require mutation policy for the bound authority.
- `POST /api/session/:sessionID/wait`: read/control surface; must not reveal unauthorized session state.
- `GET /api/session/:sessionID/permission/request` and `POST /api/session/:sessionID/permission/request/:requestID/reply`, if retained: deny or filter by session read/mutation policy as appropriate for the operation.
- `POST /api/session/:sessionID/question/request/:requestID/reply` and `POST /api/session/:sessionID/question/request/:requestID/reject`, if retained: mutation/control surfaces; require policy for the bound session authority.
- Canonical session event stream, replay, tail, or list surfaces, if retained after Milestone 2 route pruning: filter or deny unauthorized session events.

If a listed surface no longer exists after Milestone 2, do not reintroduce it only to satisfy this list. If a new canonical session surface exists, classify it as read, mutation, or control and guard it explicitly.

Authority selection:

- All auth-enabled session creation uses explicit authority selection. The server must not silently choose the only, first, active, or default authority.
- Session creation uses request body `authorityID` because it becomes durable session state.
- Non-session authority-scoped endpoints should use a standard header such as `x-gte-agent-authority` when such endpoints exist.
- Do not implement or require the non-session authority header unless Milestone 3 includes a concrete non-session authority-scoped endpoint.

## Local Dev And Testing

Provide an explicit easy auth-disabled mode for local development and tests.

Even when auth is disabled, the runtime should bind sessions to synthetic values, for example:

```ts
principalID = "dev_principal"
authorityID = "dev_authority"
```

This keeps the invariant true in all modes and avoids special-case session logic.

Local mock API/auth facilities may be used while real GTE auth APIs are unavailable. They should exercise the same request-context and session-authorization path as real auth.

## Persistence

Milestone 3 implements the auth/authority contract against local SQLite only.

Local SQLite remains development/test substrate. It should not define the final production ownership or cross-entrypoint persistence model.

Pre-MVP local SQLite databases are disposable for this milestone. Add `principalID` and `authorityID` to the current clean baseline shape produced by the pre-MVP chain; do not add a separate compatibility migration burden for historical OpenCode data.

Production GTE/server-side persistence is a later milestone TODO.

## Remove Inherited Account State

Remove inherited OpenCode account/org/device-login storage and flows from active packages:

- Account tables that store old account tokens.
- Active org state.
- Device-login flows for OpenCode console accounts.
- Legacy account commands or server routes in active packages.

Replace them with a small GTE auth/authority module shaped around bearer validation/introspection, principal extraction, authority checks, synthetic dev identity, and session authorization.

If any inherited route or command still depends on those account/org/device-login flows, remove it from the active runtime instead of securing it as a compatibility path. `packages/opencode` remains reference-only after Milestone 2.

## OpenAPI, SDK, And CLI

Milestone 3 changes the canonical API contract.

Update:

- OpenAPI auth scheme and operation docs for GTE bearer product auth.
- Session create request schema to include required `authorityID` in auth-enabled mode.
- Session response schemas to include `principalID` and `authorityID`.
- Error schemas for unauthenticated, denied read, denied mutation, and authority/session conflict cases.
- JavaScript SDK generation output by running `./packages/sdk/js/script/build.ts` after the API and generator shape are correct.
- CLI session creation to pass explicit `authorityID` in auth-enabled mode.
- CLI/local daemon code so daemon transport credentials remain distinct from GTE product bearer tokens.

## Out Of Scope

- Trading tools of any kind, including read-only account or market data tools.
- Order preview, order submission, cancel/replace, partial fill, retry, or post-crash ambiguity policy.
- Trading memory.
- Risk gates beyond authority access checks.
- Production GTE/server-side persistence.
- Interactive login UX unless GTE requires it for minimal testing.
- Final TUI information architecture.

## Implementation Checklist

1. Add GTE auth request context for bearer-token validation or introspection.
2. Add explicit auth-disabled dev/test mode with synthetic principal and authority.
3. Define the GTE auth/authority service boundary for bearer validation/introspection, request principal context, read capability checks, act capability checks, explicit errors, and HTTP mappings.
4. Add `principalID` and `authorityID` to canonical session schema, events, projections, and the current clean SQLite baseline shape.
5. Require explicit `authorityID` on auth-enabled session creation for all bearer tokens, including single-authority tokens.
6. Keep `authorityID` immutable after session creation.
7. Treat reused session IDs as exact retries only when stored `principalID` and `authorityID` match the authenticated request and requested authority; otherwise return a conflict.
8. Add per-request authorization checks for canonical session reads, mutations, controls, permission/question routes, and event/replay/list surfaces.
9. Model read and act capabilities separately.
10. Define the standard non-session authority header convention, but implement it only if a concrete non-session authority-scoped endpoint exists in this milestone.
11. Remove inherited account/org/device-login active storage and flows.
12. Remove or make unreachable any remaining inherited routes or commands that depend on old account/org/device-login flows.
13. Update OpenAPI auth scheme, operation docs, session schemas, and auth/authorization/conflict error schemas.
14. Regenerate JavaScript SDK.
15. Update CLI session creation and local daemon integration so product bearer auth and daemon transport credentials remain distinct.
16. Add local mock auth/API test support that exercises the same auth context and authority policy path as real auth.
17. Document production persistence as later TODO.
18. Verify session create, read, prompt, replay/list, auth-disabled synthetic identity, denied read, denied mutation, authority mismatch conflict, and explicit authority-selection behavior.

## Risks

- Treating authority as optional in dev mode would create two runtime contracts. Synthetic authority keeps tests and production semantics aligned.
- Treating single-authority bearer tokens as implicit authority selection would create hidden server-side selection behavior. Explicit `authorityID` is universal in auth-enabled mode.
- Persisting a tuple instead of opaque `authorityID` could prematurely lock GTE account schema. Keep `authorityID` opaque unless GTE auth guarantees a tuple as the stable identifier.
- Overloading replay/sync ownership fields for auth would mix unrelated concerns and weaken future auditing. `event_sequence.owner_id` must not become principal, authority, tenant, or access-control state.
- Implementing trading tools in this milestone would make it harder to validate the auth contract independently.
- Production persistence is intentionally deferred. The local SQLite design should stay replaceable.
- Preserving legacy routes as compatibility paths would create an auth bypass surface. Legacy routes should be unreachable before M3 or removed during M3 if any remain.
- Treating local daemon Basic/password credentials as product auth would blur transport security with GTE bearer authority.
- Forgetting OpenAPI/SDK/CLI updates would leave clients able to call stale authority-less contracts.
