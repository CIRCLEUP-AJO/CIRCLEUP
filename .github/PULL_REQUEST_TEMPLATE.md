## Summary

<!-- What does this PR do? One or two sentences. -->

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / code cleanup
- [ ] Documentation update
- [ ] CI / tooling change
- [ ] Contract change (requires extra review)
- [ ] Removes or renames a public interface (REST field, SDK export, contract event, or error message — see [Deprecation Policy](../docs/DEPRECATION_POLICY.md))

## Related Issue

Closes #<!-- issue number -->

## Changes Made

<!-- List the key changes by package. Be specific about contract, SDK, indexer, or app. -->

- 
- 
- 

## Traceability

<!-- How do the acceptance criteria for the linked issue map to observable evidence? -->
<!-- For each criterion, name the test, the documented outcome, or the CHANGELOG entry that satisfies it. -->
<!-- If a criterion has no test yet, note the gap and open a follow-up issue. -->
<!-- See docs/TRACEABILITY_POLICY.md for the full convention. -->

| Acceptance criterion | Evidence (test name / doc section / CHANGELOG entry) |
|---|---|
|  |  |

## Testing

<!-- How did you test this? What scenarios did you cover? -->

- [ ] Ran `cargo test` in `contracts/`
- [ ] Ran `npx tsc --noEmit` in `indexer/` and `scripts/`
- [ ] Ran `npm run build --workspace=app`
- [ ] Ran `npm run lint --workspace=app`
- [ ] Tested manually on testnet (if contract change)

## Contract security checklist

<!-- Complete this section if "Contract change" is checked above. -->
<!-- Work through docs/CONTRACT_SECURITY_CHECKLIST.md and paste relevant evidence below. -->
<!-- Ticking every box does not replace a specialist security audit for novel financial paths. -->

<details>
<summary>Contract security review (expand if this PR modifies contracts/)</summary>

**1. Authorization** — who is permitted to call each modified entry-point, and is `require_auth()` called before any state write?

<!-- evidence -->

**2. Arithmetic** — are all financial multiplications guarded with `checked_mul`? Is division truncating in the safe direction?

<!-- evidence -->

**3. Token transfers** — are transfers ordered after state writes? Is the recipient address validated?

<!-- evidence -->

**4. Reentrancy** — are all outbound cross-contract calls listed? Is state written before any outbound call?

<!-- evidence -->

**5. Lifecycle** — does each entry-point assert the expected `CircleStatus`? Does it respect the pause flag?

<!-- evidence -->

**6. Events** — does every observable state transition emit the correct event with a stable payload? Is `docs/EVENTS.md` updated?

<!-- evidence -->

**7. Storage cost** — how many new persistent entries does this introduce per call? Are they cleaned up in `close`?

<!-- evidence -->

**8. Rollback** — is the contract left in a consistent state if this entry-point panics? Is the rollback plan documented (gate A9)?

<!-- evidence -->

See [docs/CONTRACT_SECURITY_CHECKLIST.md](../docs/CONTRACT_SECURITY_CHECKLIST.md) for the full prompt and specialist-review assumptions.

</details>

## Checklist

- [ ] My code follows the project's style guidelines
- [ ] I have updated `CHANGELOG.md` under `[Unreleased]` with `**Issue NNN**:` prefix on new bullets
- [ ] I have added or updated relevant documentation
- [ ] I have not committed `.env` files or secrets
- [ ] CI passes on this branch
- [ ] If this PR removes or renames a public interface, I have followed the [Deprecation Policy](../docs/DEPRECATION_POLICY.md) notice procedure
- [ ] If this PR redeploys contracts, I have followed the [Deployment Lifecycle](../docs/DEPLOYMENT_LIFECYCLE.md) to archive the superseded manifest
- [ ] If this PR modifies contracts/, I have worked through [docs/CONTRACT_SECURITY_CHECKLIST.md](../docs/CONTRACT_SECURITY_CHECKLIST.md) and pasted evidence above
- [ ] If this PR changes a protocol wire format, I have followed the [Protocol and Wire-Format Changes](../CONTRIBUTING.md#protocol-and-wire-format-changes) checklist in CONTRIBUTING.md

## Screenshots (if applicable)

<!-- Add screenshots for UI changes -->
