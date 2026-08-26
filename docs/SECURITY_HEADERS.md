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

### Phase 1 — observation (current)

1. Set `NEXT_PUBLIC_CSP_REPORT_URI` to a URI that can receive violation
   reports (e.g. a simple logging endpoint, or a service such as
   [report-uri.com](https://report-uri.com)).
2. Deploy.  The header is `Content-Security-Policy-Report-Only`; nothing is
   blocked.
3. Collect violation reports for at least one full release cycle (recommended:
   2–4 weeks in production, or until no new violation types appear).
4. For each violation type, decide:
   - **Expected** (e.g. Freighter extension content-script): document and
     adjust the policy if needed.
   - **Unexpected** (e.g. an undocumented third-party script): investigate
     before proceeding to enforcement.

### Phase 2 — enforcement

Once the violation report is clean:

1. In your production environment, set:
   ```
   NEXT_PUBLIC_CSP_ENFORCE=true
   ```
2. Redeploy.  The header switches to `Content-Security-Policy`; any request
   not covered by the policy will be blocked and reported.
3. Monitor error rates and violation reports for 24–48 hours after the rollout.
4. If wallet interaction breaks, add `'unsafe-inline'` to `script-src` (see
   the Freighter note above) and re-deploy.

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
