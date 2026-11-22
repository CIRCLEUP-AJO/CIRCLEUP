# Security Headers

This document describes the HTTP security headers applied to all CircleUp app
routes, the rationale behind each, the allowed external origins, and the
procedure for promoting the Content Security Policy from observation to
enforcement.

## Headers applied

All headers are configured in `app/next.config.js` and apply to every route
matched by `source: "/(.*)"`.

### X-Frame-Options: DENY

Prevents any page from being embedded in a `<frame>`, `<iframe>`, or
`<object>`.  This is the legacy framing guard for browsers that predate CSP
`frame-ancestors` support (IE11, older Safari).  The CSP `frame-ancestors
'none'` directive covers modern browsers and takes precedence where both are
understood.

### X-Content-Type-Options: nosniff

Prevents the browser from MIME-sniffing a response away from the declared
`Content-Type`.  Without this header a response served as `text/plain` could
be executed as a script in some browsers if it happened to look like
JavaScript.

### Referrer-Policy: strict-origin-when-cross-origin

- Same-origin requests: full URL sent as `Referer` (useful for internal
  analytics and debugging).
- Cross-origin requests: only the origin is sent (`https://app.circleup.xyz`),
  not the path.  This prevents wallet addresses, circle contract addresses, or
  member identifiers embedded in URL paths from leaking to third-party servers
  (RPC, indexer, any future analytics).
- HTTPS → HTTP downgrade: no `Referer` header sent.

### Permissions-Policy

Explicitly disables browser features the app never uses:

| Feature | Setting | Reason |
|---------|---------|--------|
| `camera` | `()` | Not used |
| `microphone` | `()` | Not used |
| `geolocation` | `()` | Not used |
| `interest-cohort` | `()` | FLoC / Privacy Sandbox opt-out |
| `payment` | `()` | Payments handled via Stellar, not Payment Request API |
| `usb` | `()` | Not used |

An explicit policy prevents a third-party script injected via XSS from
silently requesting camera or microphone access.

### Content-Security-Policy (Report-Only by default)

See the [CSP section](#content-security-policy-rollout) below for full details.

---

## External origins inventory

The following third-party origins the browser must be able to reach are
reflected in `connect-src`:

| Origin | Purpose | Configured via |
|--------|---------|----------------|
| `https://soroban-testnet.stellar.org` (testnet) | Soroban RPC — transaction submission and simulation | `NEXT_PUBLIC_STELLAR_RPC_URL` |
| `https://soroban-mainnet.stellar.org` (mainnet) | Soroban RPC — mainnet equivalent | `NEXT_PUBLIC_STELLAR_RPC_URL` |
| `http://localhost:3001` (dev) / production URL | CircleUp indexer REST API | `NEXT_PUBLIC_INDEXER_URL` |

**Freighter wallet** does not require a `connect-src` entry.  It communicates
via the `window.freighter` global injected by the browser extension
(content-script message passing), not via a network fetch from the page origin.

**No CDN, analytics service, or external font provider** is currently in use.
`'self'` is therefore sufficient for `script-src`, `style-src`, `font-src`,
and `img-src`.

If a new external origin is introduced (e.g. a Sentry DSN, a hosted font, or
a third-party analytics endpoint), add it to `EXTRA_CONNECT_SRC` in
`app/next.config.js` with a comment explaining why it is required.

---

## Content Security Policy rollout

The CSP is currently delivered as `Content-Security-Policy-Report-Only`.  In
this mode violations are reported without blocking any requests, so legitimate
integrations are not broken while the policy is being validated.

### Current directives

```
default-src 'self'
script-src  'self' 'unsafe-eval' 'unsafe-inline'
style-src   'self' 'unsafe-inline'
img-src     'self' data: blob:
font-src    'self'
connect-src 'self' <rpcOrigin> <indexerOrigin>
worker-src  'self' blob:
frame-src   'none'
frame-ancestors 'none'
object-src  'none'
base-uri    'self'
form-action 'self'
report-uri  <NEXT_PUBLIC_CSP_REPORT_URI>   (if set)
```

**Note on `unsafe-eval` and `unsafe-inline` in `script-src`**: Next.js dev
mode requires `unsafe-eval` for hot module replacement.  Both directives
should be reviewed before Phase 2 enforcement; Next.js 14+ supports
[nonce-based CSP](https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)
which eliminates the need for `unsafe-inline`.

### Staged rollout overview

The CSP moves through three explicit stages.  Enforcement is **never** enabled
until the report-only inventory has been collected, grouped, and reviewed.

| Stage | Header | `NEXT_PUBLIC_CSP_ENFORCE` | Purpose |
|-------|--------|---------------------------|---------|
| 0 — off | none | unset | Local debugging only |
| 1 — report-only | `Content-Security-Policy-Report-Only` | unset / `false` | Collect and triage violations |
| 2 — enforced | `Content-Security-Policy` | `true` | Block and report violations |

### Phase 1 — report-only collection (current)

1. Set `NEXT_PUBLIC_CSP_REPORT_URI` to a URI that can receive violation
   reports (e.g. a simple logging endpoint, or a service such as
   [report-uri.com](https://report-uri.com)).
2. Deploy.  The header is `Content-Security-Policy-Report-Only`; nothing is
   blocked.
3. Capture violations in a controlled environment first (staging or a
   dedicated test deployment), then in production for at least one full
   release cycle (recommended: 2–4 weeks, or until no new violation types
   appear).
4. Group every report by `violated-directive` (or `effective-directive`) and
   `blocked-uri` / `source-file` origin.  Only the directive and the origin
   are needed for triage — see the privacy rules below.

### Privacy-safe violation reporting

Violation reports must not become a side channel for user data.  Before
enabling `NEXT_PUBLIC_CSP_REPORT_URI`:

- **Strip query strings and fragments** from `document-uri` and
  `blocked-uri` at the collector.  CircleUp URLs can contain wallet
  addresses, circle contract addresses, or member identifiers in the path.
- **Never log request bodies, form data, or transaction payloads.**  CSP
  reports do not include them, but the collector must not be configured to
  capture them either.
- **Do not store full `document-uri` paths** for authenticated routes; keep
  only the origin plus a coarse route bucket (e.g. `/app/*`).
- **Retain reports for a bounded window** (e.g. 30 days) and restrict access
  to the security maintainers.
- If a third-party reporting service is used, confirm in writing that it
  does not retain or resell report contents and that its retention matches
  the window above.

If any of these cannot be guaranteed, leave `NEXT_PUBLIC_CSP_REPORT_URI`
unset and triage using browser devtools in a controlled environment instead.

### Violation triage and reviewed allowlist

For each grouped violation type, record a decision in the table below and
keep it in this document.  Enforcement may only proceed when every entry is
**Expected** or **Resolved**.

| Directive | Blocked origin / source | Classification | Decision |
|-----------|-------------------------|----------------|----------|
| `script-src` | `'unsafe-inline'` (Next.js dev HMR) | Expected (dev only) | Nonce-based CSP before enforcement |
| `script-src` | Freighter content-script injection | Expected | Verify in wallet test path; no wildcard |
| `connect-src` | Soroban RPC origin | Expected | Already in allowlist |
| `connect-src` | Indexer origin | Expected | Already in allowlist |

Rules for the allowlist:

- Add **exact origins only**.  Do **not** add broad wildcards
  (`https:`, `*`, `*.example.com`) to silence reports — a wildcard defeats
  the purpose of the policy and hides real regressions.
- Every relaxed directive (e.g. keeping `'unsafe-inline'` in `style-src`)
  must have a documented reason in this file.
- Any new origin goes through `EXTRA_CONNECT_SRC` and the
  [External origins inventory](#external-origins-inventory) table.

### Integration test path (wallet and explorer)

Before flipping to enforcement, verify the following in a staging
deployment with the **enforced** header active:

1. **App assets** — load every top-level route and confirm no `script-src`,
   `style-src`, `font-src`, or `img-src` violations in the console.
2. **Freighter connect** — connect, sign, and submit a transaction; confirm
   the wallet prompt appears and no `script-src` violation is reported.
3. **Explorer links** — open a transaction and an account link to the
   Stellar explorer; confirm `frame-src 'none'` and `connect-src` do not
   block the navigation.
4. **Indexer reads** — load a circle and member list; confirm
   `connect-src` allows the indexer origin.
5. Record the test run (date, build SHA, result) alongside the triage table.

### Phase 2 — enforcement

Once the violation report is clean and the integration test path passes:

1. In your production environment, set:
   ```
   NEXT_PUBLIC_CSP_ENFORCE=true
   ```
2. Redeploy.  The header switches to `Content-Security-Policy`; any request
   not covered by the policy will be blocked and reported.
3. Monitor error rates and violation reports for 24–48 hours after the rollout.
4. If wallet interaction breaks, follow the rollback procedure below rather
   than adding `'unsafe-inline'` to `script-src` in production.

### Rollback criteria and procedure

Roll back to report-only if **any** of the following occurs after
enforcement:

- Freighter connect, sign, or submit fails for any user.
- A required app asset (script, style, font, image) fails to load.
- Explorer or indexer navigation is blocked.
- A new, unexplained violation type appears in reports.

To disable enforcement safely:

1. Unset `NEXT_PUBLIC_CSP_ENFORCE` (or set it to `false`) in the
   environment configuration.
2. Redeploy.  The header reverts to `Content-Security-Policy-Report-Only`;
   nothing is blocked and reporting continues.
3. File an issue with the grouped violation data (privacy-safe fields only)
   and update the triage table before attempting enforcement again.

Do not "fix" a rollback by widening the policy with wildcards; fix the
underlying requirement or the allowlist entry instead.

### Freighter wallet compatibility

Freighter v2 communicates via `window.freighter` (a global injected by the
extension's content script) — it does **not** make network requests from the
page origin, so no `connect-src` exception is needed for it.

The extension may inject inline scripts into the page DOM.  If enforcement
blocks wallet connection, inspect the violation report for `script-src`
violations and either:
- Add `'unsafe-inline'` to `script-src` (lower security, simpler), or
- Implement [nonce-based CSP](https://nextjs.org/docs/app/building-your-application/configuring/content-security-policy)
  in Next.js middleware (higher security, more work).

---

## Testing headers locally

```bash
# Start the Next.js dev server
cd app && npm run dev

# In a second terminal, check the response headers on the home route
curl -s -D - http://localhost:3000 -o /dev/null | grep -i "content-security\|x-frame\|x-content\|referrer\|permissions"
```

Expected output (observation mode):

```
content-security-policy-report-only: default-src 'self'; ...
x-frame-options: DENY
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
permissions-policy: camera=(), microphone=(), ...
```

---

## Changing this configuration

All header values are derived from environment variables and the
`EXTRA_CONNECT_SRC` array in `app/next.config.js`.  To add a new allowed
origin:

1. Add it to `EXTRA_CONNECT_SRC` with a comment.
2. Update the [External origins inventory](#external-origins-inventory) table
   in this document.
3. Verify the header is present and correct with `curl` (see above).
4. Submit the change for review — CSP changes should be peer-reviewed even
   when the app is in Report-Only mode.
5. Update the [violation triage table](#violation-triage-and-reviewed-allowlist)
   with the reason for any relaxed directive.
