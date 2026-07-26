# Task: Add transaction boundaries around indexer writes

## Steps

1. ✅ Plan approved
2. [ ] Edit `indexer/src/db/pool.ts` — Add `transaction()` function
3. [ ] Edit `indexer/src/indexer.ts` — Update `processEvents()` to use transactions
4. [ ] Edit `indexer/src/indexer.ts` — Update multi-query handlers (`handleCirclePayout`, `handleCircleDefault`) to accept transactional query
5. [ ] Edit `indexer/src/indexer.ts` — Update single-query handlers for consistency
6. [ ] Test — Verify indexer starts without errors

