# Task: Add transaction boundaries around indexer writes

## Steps

1. ✅ Plan approved
2. ✅ Edit `indexer/src/db/pool.ts` — Added `withTransaction()` function
3. ✅ Edit `indexer/src/indexer.ts` — Added `ingestEvent()` wrapping each event in `withTransaction()`
4. ✅ Edit `indexer/src/indexer.ts` — Updated all handlers to accept `client: PoolClient` parameter
5. ✅ Edit `indexer/src/db/schema.sql` — Added `ingested_events` table for dedup tracking
6. ✅ Added `indexer/src/indexer.test.ts` — Unit tests for `createEventKey`

## Status: ✅ Complete

All indexer writes are now wrapped in database transactions via `withTransaction()`.
Each event is atomically processed (event logged + data written) within a single transaction.
Multi-query handlers (`handleCirclePayout`, `handleCircleDefault`) share the same transactional client.
Events are deduplicated via `ingested_events` table with deterministic event keys.

## Transaction Architecture

### withTransaction() contract
- Input: callback `(client: PoolClient) => Promise<T>`
- Output: `Promise<T>` — result of the callback
- Side effects: `BEGIN`, `COMMIT`, or `ROLLBACK` on the connection

### Atomicity guarantees
- `handleCirclePayout`: payout INSERT + circles.current_round UPDATE in one tx
- `handleCircleDefault`: defaults INSERT + circle_members.defaults UPDATE in one tx
- `handleFactoryCircleCreated`: circles INSERT in one tx
- `handleCircleJoined`: circle_members UPDATE in one tx
- `handleCircleActive`: circles.status UPDATE in one tx
- `handleCircleContributed`: contributions INSERT in one tx
- `handleCircleCompleted`: circles.status UPDATE in one tx
- `handleReputationIncrement`: reputation UPSERT in one tx

### Deduplication mechanism
- `createEventKey()` produces a deterministic hash from ledger, txHash, contractId, topics, value
- `ingested_events` table uses event_key as PRIMARY KEY
- On CONFLICT DO NOTHING ensures idempotent replay safety
- Duplicate events are skipped with debug log

### Rollback scenarios
- Network failure mid-transaction → ROLLBACK, no partial writes
- RPC query failure → ROLLBACK, retry on next poll cycle
- Constraint violation → ROLLBACK, error logged
- Handler exception → ROLLBACK, error logged

### Recovery guarantees
- Processing restarts from last_ledger in indexer_state
- Already-ingested events are skipped via ingested_events lookup
- No double-spend risk on payouts or defaults
- No duplicate contributions recorded

### Test coverage
- createEventKey stability for identical events
- createEventKey sensitivity to differing event content
Web App Development — 225-Item TODO Checklist

1. Planning & Requirements

- [ ] 001. Define the purpose of the web app.
- [ ] 002. Define the problem it solves.
- [ ] 003. Identify target users.
- [ ] 004. Define user roles.
- [ ] 005. List the core features.
- [ ] 006. Separate MVP features from optional features.
- [ ] 007. Define functional requirements.
- [ ] 008. Define security requirements.
- [ ] 009. Define performance requirements.
- [ ] 010. Map the main user journeys.

2. UI/UX Design

- [ ] 011. Choose the design style.
- [ ] 012. Choose the color palette.
- [ ] 013. Choose typography.
- [ ] 014. Define button styles.
- [ ] 015. Define input styles.
- [ ] 016. Design the landing page.
- [ ] 017. Design the navigation.
- [ ] 018. Design the login page.
- [ ] 019. Design the registration page.
- [ ] 020. Design the dashboard.
- [ ] 021. Design the profile page.
- [ ] 022. Design the settings page.
- [ ] 023. Design loading states.
- [ ] 024. Design error states.
- [ ] 025. Design responsive layouts.

3. Project Setup

- [ ] 026. Install VS Code.
- [ ] 027. Install Node.js.
- [ ] 028. Install Git.
- [ ] 029. Create the project folder.
- [ ] 030. Open the project in VS Code.
- [ ] 031. Initialize Git.
- [ ] 032. Create ".gitignore".
- [ ] 033. Create README.md.
- [ ] 034. Initialize the package manager.
- [ ] 035. Choose the frontend framework.
- [ ] 036. Choose the backend framework.
- [ ] 037. Choose the database.
- [ ] 038. Choose the styling system.
- [ ] 039. Configure environment variables.
- [ ] 040. Install useful VS Code extensions.

4. Frontend Foundation

- [ ] 041. Create the frontend application.
- [ ] 042. Create the components folder.
- [ ] 043. Create the pages folder.
- [ ] 044. Create the layouts folder.
- [ ] 045. Create the hooks folder.
- [ ] 046. Create the utilities folder.
- [ ] 047. Create the services folder.
- [ ] 048. Create the assets folder.
- [ ] 049. Configure global styles.
- [ ] 050. Create the main layout.
- [ ] 051. Create the navigation component.
- [ ] 052. Create the footer component.
- [ ] 053. Create the button component.
- [ ] 054. Create the input component.
- [ ] 055. Create the modal component.

5. Routing

- [ ] 056. Configure routing.
- [ ] 057. Create the home route.
- [ ] 058. Create the login route.
- [ ] 059. Create the registration route.
- [ ] 060. Create the dashboard route.
- [ ] 061. Create the profile route.
- [ ] 062. Create the settings route.
- [ ] 063. Create feature routes.
- [ ] 064. Create the 404 page.
- [ ] 065. Create protected routes.
- [ ] 066. Create route guards.
- [ ] 067. Test unauthorized navigation.
- [ ] 068. Test authenticated navigation.

6. Backend

- [ ] 069. Create the backend application.
- [ ] 070. Create controllers.
- [ ] 071. Create models.
- [ ] 072. Create services.
- [ ] 073. Create API routes.
- [ ] 074. Create middleware.
- [ ] 075. Create validators.
- [ ] 076. Configure environment variables.
- [ ] 077. Configure CORS.
- [ ] 078. Configure error handling.
- [ ] 079. Configure logging.
- [ ] 080. Create a health-check endpoint.
- [ ] 081. Test API requests.
- [ ] 082. Connect frontend to backend.

7. Database

- [ ] 083. Set up the database.
- [ ] 084. Create the development database.
- [ ] 085. Design the database schema.
- [ ] 086. Identify database entities.
- [ ] 087. Define primary keys.
- [ ] 088. Define foreign keys.
- [ ] 089. Define relationships.
- [ ] 090. Define required fields.
- [ ] 091. Define unique constraints.
- [ ] 092. Create the users table.
- [ ] 093. Create role tables if required.
- [ ] 094. Create application-specific tables.
- [ ] 095. Create database migrations.
- [ ] 096. Run migrations.
- [ ] 097. Add seed/test data.
- [ ] 098. Test database queries.

8. Authentication

- [ ] 099. Create registration functionality.
- [ ] 100. Create login functionality.
- [ ] 101. Create logout functionality.
- [ ] 102. Hash passwords securely.
- [ ] 103. Validate passwords.
- [ ] 104. Implement authentication.
- [ ] 105. Implement authentication middleware.
- [ ] 106. Protect private API endpoints.
- [ ] 107. Create password reset.
- [ ] 108. Create email verification if required.
- [ ] 109. Handle invalid credentials.
- [ ] 110. Handle expired sessions.
- [ ] 111. Handle unauthorized requests.
- [ ] 112. Test the authentication flow.

9. Main Features

- [ ] 113. Build the main dashboard.
- [ ] 114. Display user information.
- [ ] 115. Display application statistics.
- [ ] 116. Build the primary feature page.
- [ ] 117. Implement create functionality.
- [ ] 118. Implement read functionality.
- [ ] 119. Implement update functionality.
- [ ] 120. Implement delete functionality.
- [ ] 121. Add search.
- [ ] 122. Add filtering.
- [ ] 123. Add sorting.
- [ ] 124. Add pagination.
- [ ] 125. Add confirmation dialogs.
- [ ] 126. Add success notifications.
- [ ] 127. Add error notifications.
- [ ] 128. Add loading states.
- [ ] 129. Add empty states.
- [ ] 130. Connect features to the API.
- [ ] 131. Test the complete workflow.

10. Forms & Validation

- [ ] 132. Identify all application forms.
- [ ] 133. Define required fields.
- [ ] 134. Add frontend validation.
- [ ] 135. Add backend validation.
- [ ] 136. Validate email fields.
- [ ] 137. Validate passwords.
- [ ] 138. Validate numbers and dates.
- [ ] 139. Validate file uploads.
- [ ] 140. Display validation errors.
- [ ] 141. Display server errors.
- [ ] 142. Prevent duplicate submissions.
- [ ] 143. Disable buttons during submission.
- [ ] 144. Test invalid input.
- [ ] 145. Test missing input.
- [ ] 146. Test successful submissions.

11. User Experience

- [ ] 147. Add loading indicators.
- [ ] 148. Add useful error messages.
- [ ] 149. Add success messages.
- [ ] 150. Add confirmation messages.
- [ ] 151. Prevent accidental destructive actions.
- [ ] 152. Add keyboard navigation.
- [ ] 153. Add focus states.
- [ ] 154. Add hover states.
- [ ] 155. Add disabled states.
- [ ] 156. Make navigation responsive.
- [ ] 157. Test mobile screens.
- [ ] 158. Test desktop screens.
- [ ] 159. Check readability.
- [ ] 160. Check spacing consistency.
- [ ] 161. Check visual consistency.

12. Security

- [ ] 162. Never expose secrets in frontend code.
- [ ] 163. Add ".env" to ".gitignore".
- [ ] 164. Validate server input.
- [ ] 165. Sanitize user-generated content.
- [ ] 166. Protect authenticated endpoints.
- [ ] 167. Verify user permissions.
- [ ] 168. Prevent privilege escalation.
- [ ] 169. Secure password storage.
- [ ] 170. Configure secure cookies if applicable.
- [ ] 171. Configure HTTPS for production.
- [ ] 172. Configure CORS correctly.
- [ ] 173. Prevent SQL injection.
- [ ] 174. Prevent XSS.
- [ ] 175. Protect file uploads.
- [ ] 176. Review dependency vulnerabilities.
- [ ] 177. Perform a security review.

13. Performance

- [ ] 178. Measure page loading speed.
- [ ] 179. Identify slow components.
- [ ] 180. Optimize images.
- [ ] 181. Remove unused dependencies.
- [ ] 182. Optimize database queries.
- [ ] 183. Add database indexes where needed.
- [ ] 184. Implement API pagination.
- [ ] 185. Avoid unnecessary API requests.
- [ ] 186. Debounce search inputs.
- [ ] 187. Optimize large lists.
- [ ] 188. Check memory usage.
- [ ] 189. Check CPU usage.
- [ ] 190. Test on slower devices.

14. Accessibility

- [ ] 191. Use semantic HTML.
- [ ] 192. Add labels to form inputs.
- [ ] 193. Add alt text to images.
- [ ] 194. Check color contrast.
- [ ] 195. Ensure keyboard accessibility.
- [ ] 196. Ensure visible focus indicators.
- [ ] 197. Use accessible buttons.
- [ ] 198. Use accessible navigation.
- [ ] 199. Add appropriate ARIA attributes.
- [ ] 200. Check heading hierarchy.
- [ ] 201. Test keyboard-only navigation.
- [ ] 202. Fix accessibility warnings.

15. Testing

- [ ] 203. Create a testing strategy.
- [ ] 204. Test the landing page.
- [ ] 205. Test registration.
- [ ] 206. Test login.
- [ ] 207. Test logout.
- [ ] 208. Test password reset.
- [ ] 209. Test dashboard.
- [ ] 210. Test profile.
- [ ] 211. Test CRUD operations.
- [ ] 212. Test search.
- [ ] 213. Test filtering.
- [ ] 214. Test forms.
- [ ] 215. Test validation.
- [ ] 216. Test error handling.
- [ ] 217. Test different user roles.
- [ ] 218. Test API endpoints.
- [ ] 219. Test database operations.
- [ ] 220. Test mobile responsiveness.
- [ ] 221. Test different browsers.
- [ ] 222. Fix discovered bugs.

16. Final Launch

- [ ] 223. Review the complete application.
- [ ] 224. Deploy the application.
- [ ] 225. Monitor the production application.
TODO — Harden Indexer Replay Validation

Description: Replay is a recovery tool and must not mutate the wrong network or process an unbounded range by mistake. Dry-run scope must be obvious.

1. Review Existing Implementation

[ ] Open indexer/src/db/replay.ts.

[ ] Identify command-line argument parsing.

[ ] Identify network/environment selection.

[ ] Identify replay range parsing.

[ ] Identify batch-size handling.

[ ] Identify mutation/write behavior.

[ ] Identify existing dry-run behavior.

[ ] Identify resume/checkpoint behavior.

[ ] Review existing replay tests.

[ ] Review database projection write functions.

[ ] Review indexer network configuration.

[ ] Confirm how replay identifies the target network.

[ ] Confirm how replay determines the start position.

[ ] Confirm how replay determines the end position.

[ ] Confirm whether omitted arguments currently have defaults.

[ ] Identify any potentially unsafe defaults.


2. Network Validation

[ ] Require an explicit network for replay.

[ ] Validate network against the supported network list.

[ ] Reject unknown network names.

[ ] Reject empty network values.

[ ] Reject network values containing unexpected characters.

[ ] Ensure network selection cannot fall back silently.

[ ] Ensure replay cannot accidentally use production configuration.

[ ] Verify database connection matches the selected network.

[ ] Ensure network is included in the printed replay scope.

[ ] Add tests for invalid network names.

[ ] Add tests for missing network.

[ ] Add tests for valid network selection.

[ ] Add tests ensuring another network is never touched.


3. Range Validation

[ ] Require an explicit replay range.

[ ] Validate the range start.

[ ] Validate the range end.

[ ] Reject non-numeric values.

[ ] Reject negative values where unsupported.

[ ] Reject NaN.

[ ] Reject infinite values.

[ ] Reject fractional values if ranges require integers.

[ ] Reject start > end.

[ ] Decide and document whether start === end is valid.

[ ] Reject an empty range when it is ambiguous.

[ ] Reject unbounded start values.

[ ] Reject unbounded end values.

[ ] Prevent accidental full-history replay.

[ ] Add a maximum allowed range size.

[ ] Make the maximum range configurable if appropriate.

[ ] Print the exact start and end values before execution.


4. Batch Size Validation

[ ] Require a positive batch size.

[ ] Reject zero.

[ ] Reject negative batch sizes.

[ ] Reject non-numeric batch sizes.

[ ] Reject fractional batch sizes.

[ ] Reject NaN.

[ ] Reject infinite values.

[ ] Add a safe maximum batch size.

[ ] Prevent extremely large batches from exhausting memory.

[ ] Print the selected batch size in the replay scope.

[ ] Test minimum valid batch size.

[ ] Test maximum valid batch size.

[ ] Test values above the maximum.

[ ] Test invalid batch-size input.


5. Explicit Mutation Mode

[ ] Make dry-run the default behavior.

[ ] Require an explicit write flag for mutations.

[ ] Use an unambiguous flag such as --write.

[ ] Reject ambiguous mutation arguments.

[ ] Ensure --dry-run never enables writes.

[ ] Ensure --write is required before projection mutation.

[ ] Do not infer write mode from environment.

[ ] Do not infer write mode from network.

[ ] Print DRY RUN prominently when write mode is disabled.

[ ] Print WRITE MODE prominently when mutation is enabled.

[ ] Include a clear warning before writes begin.

[ ] Ensure dry-run exits without database mutation.


6. Scope Output

[ ] Print the selected network.

[ ] Print replay start.

[ ] Print replay end.

[ ] Print total range size.

[ ] Print batch size.

[ ] Print mutation mode.

[ ] Print resume/checkpoint state.

[ ] Print target projection/database context where safe.

[ ] Make dry-run status visually obvious.

[ ] Ensure secrets are never printed.

[ ] Ensure database credentials are never printed.

[ ] Ensure connection strings are never printed.

[ ] Require validation to complete before replay starts.

[ ] Do not partially execute before printing the final scope.


7. Malformed Command Protection

[ ] Reject unknown command-line options.

[ ] Reject duplicate conflicting flags.

[ ] Reject missing required values.

[ ] Reject unexpected positional arguments.

[ ] Reject conflicting --dry-run/--write combinations.

[ ] Reject malformed ranges.

[ ] Reject malformed network names.

[ ] Reject malformed batch sizes.

[ ] Return a non-zero exit code on validation failure.

[ ] Ensure validation failure performs zero writes.

[ ] Ensure validation errors do not partially initialize replay.

[ ] Add regression tests for every rejected input.


8. Replay Execution

[ ] Keep replay processing bounded by the validated range.

[ ] Process records in deterministic order.

[ ] Use the validated batch size.

[ ] Never silently expand the requested range.

[ ] Ensure each batch stays inside the requested range.

[ ] Ensure the final batch can be smaller than the configured size.

[ ] Stop exactly at the requested end.

[ ] Preserve existing projection semantics.

[ ] Avoid changing unrelated indexer behavior.

[ ] Keep dry-run execution path separate from mutation path.

[ ] Ensure dry-run still reports what would be processed.


9. Resumable Batches

[ ] Review existing checkpoint/resume logic.

[ ] Ensure checkpoints are scoped to the selected network.

[ ] Ensure checkpoints are scoped to the replay range.

[ ] Ensure checkpoints are scoped to the relevant projection if necessary.

[ ] Prevent a checkpoint from another network being reused.

[ ] Prevent a checkpoint outside the requested range from being used.

[ ] Validate resume position before processing.

[ ] Resume from the correct batch boundary.

[ ] Test interruption and resume.

[ ] Test resume after a completed batch.

[ ] Test resume at the final batch.

[ ] Ensure resumed replay produces the same final state.


10. Idempotency

[ ] Identify projection writes affected by replay.

[ ] Confirm replaying the same range does not corrupt state.

[ ] Use existing upsert/idempotent operations where appropriate.

[ ] Avoid duplicate records.

[ ] Avoid duplicate events.

[ ] Avoid double-counting derived values.

[ ] Replay an identical range twice in tests.

[ ] Compare resulting projection state.

[ ] Confirm both executions produce equivalent state.

[ ] Test idempotency across batch boundaries.

[ ] Test idempotency after resume.


11. Tests

[ ] Test valid replay command.

[ ] Test missing network.

[ ] Test invalid network.

[ ] Test missing range.

[ ] Test malformed start.

[ ] Test malformed end.

[ ] Test start > end.

[ ] Test empty range.

[ ] Test unbounded range.

[ ] Test negative range.

[ ] Test zero batch size.

[ ] Test negative batch size.

[ ] Test non-numeric batch size.

[ ] Test excessive batch size.

[ ] Test default dry-run behavior.

[ ] Test explicit --dry-run.

[ ] Test explicit --write.

[ ] Test conflicting write flags.

[ ] Test dry-run performs zero writes.

[ ] Test malformed commands perform zero writes.

[ ] Test scope output contains network.

[ ] Test scope output contains range.

[ ] Test scope output contains batch size.

[ ] Test scope output clearly identifies dry-run.

[ ] Test bounded batch processing.

[ ] Test resumable replay.

[ ] Test replay idempotency.

[ ] Test cross-network isolation.

[ ] Test repeated replay of the same range.


12. Documentation

[ ] Document required replay arguments.

[ ] Document supported networks.

[ ] Document valid range syntax.

[ ] Document range limits.

[ ] Document batch-size limits.

[ ] Document that dry-run is the default.

[ ] Document the explicit write flag.

[ ] Document the scope output.

[ ] Document resume behavior.

[ ] Document idempotency guarantees.

[ ] Add safe command examples.

[ ] Add dry-run example.

[ ] Add write-mode example.

[ ] Add invalid-command examples.

[ ] Warn against unbounded production replay.

[ ] Document recovery procedure for interrupted replay.


13. Acceptance Validation

[ ] Confirm malformed commands cannot mutate projections.

[ ] Confirm wrong-network commands are rejected.

[ ] Confirm replay ranges are always bounded.

[ ] Confirm batch sizes are bounded.

[ ] Confirm dry-run performs zero writes.

[ ] Confirm write mode requires explicit opt-in.

[ ] Confirm scope is printed before processing.

[ ] Confirm resume cannot cross network/range boundaries.

[ ] Confirm replay is deterministic.

[ ] Confirm replay is idempotent.

[ ] Run all replay tests.

[ ] Run relevant indexer tests.

[ ] Verify no unrelated projection behavior changed.

[ ] Review the final diff for accidental write paths.

[ ] Verify no secrets appear in logs.

[ ] Verify documentation is included in the PR.


PR Checklist

[ ] Network validation

[ ] Range validation

[ ] Batch-size validation

[ ] Explicit write mode

[ ] Safe dry-run

[ ] Scope output

[ ] Replay/resume tests

[ ] Cross-network isolation tests

[ ] Idempotency tests

[ ] Documentation

[ ] No unbounded replay path

[ ] No accidental mutation path

[ ] Acceptance criteria verified
TODO — Stable API Numeric/Wire-Type Contract

Description: JavaScript clients can lose precision when API amounts and ledger values are serialized as numbers. Responses need explicit units and stable wire types.

1. Inventory Existing Serialization

[ ] Search API serializers for financial/ledger fields.

[ ] Search DTOs and response schemas.

[ ] Search SDK response types.

[ ] Search frontend/app models consuming API responses.

[ ] Identify all amount fields.

[ ] Identify all stroop fields.

[ ] Identify all ledger sequence fields.

[ ] Identify timestamp fields.

[ ] Identify token/asset quantity fields.

[ ] Identify pagination/cursor fields.

[ ] Identify database BigInt values.

[ ] Identify JavaScript number conversions.

[ ] Identify Number(...) usage on large integers.

[ ] Identify parseInt(...) usage on API values.

[ ] Identify implicit JSON serialization.

[ ] Identify fields currently returned as JSON numbers.

[ ] Identify SDK assumptions about numeric fields.

[ ] Identify app assumptions about numeric fields.

[ ] Record potentially unsafe fields in an inventory.


2. Define Wire-Type Rules

[ ] Treat financial quantities as exact values.

[ ] Return large integer amounts as strings.

[ ] Return stroop values as decimal integer strings.

[ ] Return ledger sequence values as strings where precision may exceed JS safe integers.

[ ] Keep ordinary small counts as numbers where appropriate.

[ ] Define timestamp representation explicitly.

[ ] Define timestamp units explicitly.

[ ] Define whether timestamps are ISO-8601 strings or integer epochs.

[ ] Avoid ambiguous numeric fields.

[ ] Never serialize financial values through floating-point arithmetic.

[ ] Never use Number() for exact financial quantities.

[ ] Avoid parseFloat() for monetary amounts.

[ ] Define decimal/token precision explicitly.

[ ] Define nullable numeric fields.

[ ] Define optional numeric fields.

[ ] Define empty-value behavior.

[ ] Ensure every numeric field has a documented unit.


3. Version the Contract

[ ] Review the current API response versioning strategy.

[ ] Define the new response contract version.

[ ] Choose a compatibility strategy.

[ ] Avoid silently changing existing field types without documentation.

[ ] Determine whether a versioned endpoint is required.

[ ] Determine whether a response-version header is sufficient.

[ ] Document the selected strategy.

[ ] Define migration behavior for existing clients.

[ ] Define deprecation behavior for old numeric fields.

[ ] Define removal timeline if applicable.

[ ] Ensure SDK can identify the contract version.

[ ] Ensure app can consume the selected version.

[ ] Add contract fixtures representing the new wire format.


4. API Serializers

[ ] Update amount serializers.

[ ] Update stroop serializers.

[ ] Update ledger serializers.

[ ] Update token quantity serializers.

[ ] Update database BigInt serialization.

[ ] Prevent implicit BigInt conversion to number.

[ ] Ensure exact integers are converted directly to strings.

[ ] Preserve negative values where the domain permits them.

[ ] Preserve zero exactly.

[ ] Preserve leading/sign conventions consistently.

[ ] Ensure serializers never emit NaN.

[ ] Ensure serializers never emit Infinity.

[ ] Ensure serializers never emit scientific notation for exact integers.

[ ] Ensure nullability remains consistent.

[ ] Review error responses containing numeric fields.


5. Financial Amounts

[ ] Identify all currency/token amount fields.

[ ] Document their smallest unit.

[ ] Document decimal precision.

[ ] Return exact amounts as strings.

[ ] Ensure 0 becomes "0" where the field is string-based.

[ ] Test maximum supported amount.

[ ] Test minimum supported amount.

[ ] Test values around Number.MAX_SAFE_INTEGER.

[ ] Test values above Number.MAX_SAFE_INTEGER.

[ ] Test values with many digits.

[ ] Test negative values where supported.

[ ] Test serialization/deserialization round trips.

[ ] Verify no precision changes occur.


6. Ledger Values

[ ] Inventory all ledger sequence fields.

[ ] Define ledger units explicitly.

[ ] Define ledger wire type.

[ ] Return unsafe ledger integers as strings.

[ ] Test values below the JS safe-integer boundary.

[ ] Test Number.MAX_SAFE_INTEGER.

[ ] Test Number.MAX_SAFE_INTEGER + 1.

[ ] Test realistic large ledger values.

[ ] Verify SDK does not coerce them into numbers.

[ ] Verify frontend does not coerce them into numbers.

[ ] Ensure sorting logic remains correct.

[ ] Ensure comparisons use appropriate string/bigint handling.


7. Timestamps

[ ] Inventory every timestamp field.

[ ] Identify timestamp units.

[ ] Identify whether values represent seconds, milliseconds, or another unit.

[ ] Document timestamp units.

[ ] Define timestamp wire type.

[ ] Prefer an unambiguous representation.

[ ] Ensure consumers do not guess timestamp units.

[ ] Test epoch boundary values.

[ ] Test current timestamps.

[ ] Test large epoch values.

[ ] Test timestamp round trips.

[ ] Document timezone expectations.

[ ] Ensure timestamps remain backwards compatible where required.


8. SDK Changes

[ ] Update SDK response interfaces/types.

[ ] Change unsafe numeric fields to strings.

[ ] Add explicit unit/type documentation to SDK types.

[ ] Remove unsafe numeric coercion.

[ ] Update SDK parsing logic.

[ ] Preserve exact wire values.

[ ] Add helpers for converting values when explicitly requested.

[ ] Ensure helpers use BigInt or decimal-safe libraries.

[ ] Avoid automatic conversion to JavaScript number.

[ ] Update SDK fixtures.

[ ] Update SDK tests.

[ ] Check generated types if applicable.

[ ] Check API client code generation assumptions.


9. Application Changes

[ ] Search for consumers of changed fields.

[ ] Remove direct arithmetic on string amounts.

[ ] Replace unsafe Number(value) conversions.

[ ] Replace unsafe parseInt(value) conversions where necessary.

[ ] Use BigInt for integer arithmetic where appropriate.

[ ] Use decimal-safe handling for decimal quantities.

[ ] Update UI formatting helpers.

[ ] Update sorting logic.

[ ] Update filtering logic.

[ ] Update pagination handling.

[ ] Update tests using numeric fixtures.

[ ] Ensure displayed values remain unchanged for users.


10. Boundary Tests

[ ] Test 0.

[ ] Test 1.

[ ] Test maximum normal amount.

[ ] Test Number.MAX_SAFE_INTEGER.

[ ] Test Number.MAX_SAFE_INTEGER + 1.

[ ] Test values significantly above safe integer range.

[ ] Test maximum expected ledger.

[ ] Test large stroop amount.

[ ] Test large token quantity.

[ ] Test timestamp boundaries.

[ ] Verify JSON serialization preserves exact strings.

[ ] Verify JSON parsing preserves exact strings.

[ ] Verify API → SDK preserves values.

[ ] Verify SDK → app preserves values.

[ ] Verify app display preserves values.


11. Compatibility Tests

[ ] Test existing clients against the compatibility behavior.

[ ] Test new clients against the new contract.

[ ] Verify old response fields where they remain supported.

[ ] Verify deprecated fields behave consistently.

[ ] Test version negotiation if implemented.

[ ] Test unsupported response versions.

[ ] Document intentional breaking changes.

[ ] Ensure compatibility behavior is covered by tests.

[ ] Ensure no silent precision conversion occurs.


12. Documentation

[ ] Document the response contract.

[ ] Document every numeric field.

[ ] Document units for amounts.

[ ] Document stroops.

[ ] Document ledger sequences.

[ ] Document timestamps.

[ ] Document wire types.

[ ] Document string-based integer fields.

[ ] Document decimal precision.

[ ] Document nullability.

[ ] Document versioning.

[ ] Document compatibility behavior.

[ ] Add API response examples.

[ ] Add SDK usage examples.

[ ] Warn consumers against converting exact values to number.


13. Validation

[ ] Run API serializer tests.

[ ] Run SDK tests.

[ ] Run app tests.

[ ] Run contract tests.

[ ] Test JSON round trips.

[ ] Test all boundary-sized values.

[ ] Verify no financial value is rounded.

[ ] Verify every numeric field has documented units.

[ ] Verify wire types match the contract.

[ ] Verify compatibility behavior is deliberate.

[ ] Review generated API/SDK types.

[ ] Review all changed consumers.

[ ] Check for remaining unsafe numeric conversions.


PR Checklist

[ ] Numeric serialization inventory completed.

[ ] Versioned response contract defined.

[ ] Large financial integers returned as strings.

[ ] Stroops explicitly documented.

[ ] Ledger units/types explicitly documented.

[ ] Timestamp units explicitly documented.

[ ] SDK types updated.

[ ] App consumers updated.

[ ] Boundary tests added.

[ ] JSON precision tests added.

[ ] Compatibility tests added.

[ ] Documentation updated.

[ ] No financial rounding.

[ ] No unsafe implicit number conversion.

[ ] API → SDK → app flow verified.

[ ] PR explains compatibility behavior.
