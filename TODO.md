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
