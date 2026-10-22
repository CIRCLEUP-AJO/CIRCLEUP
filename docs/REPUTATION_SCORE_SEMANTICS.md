# Reputation Score Semantics and Limitations

## What the Score Measures

**The reputation score is a count of completed ROSCA rounds, not a general credit rating.**

A member's score increments by exactly 1 when they complete a round in a circle. The score reflects:

- **What it counts:** Number of times this member successfully completed a full ROSCA circle and received their payout.
- **Who tracks it:** The on-chain Reputation contract records this count in persistent storage (u32, monotonically increasing).
- **Who can award it:** Only circle contracts registered by the factory can increment a member's score, and revocation is permanent.

## How Scores Are Updated

### Score Increment Trigger

A member's score increments **only** when:

1. Their circle completes a full round and reaches the payout phase.
2. The circle contract calls `reputation.increment(member_address)`.
3. The call succeeds (the circle is authorized and not revoked).

**Exactly one point per completion** — no partial credit, no adjustments, no decay.

### Score History

The indexer maintains a historical record of score updates from `reputation/score_updated` events. This allows:

- Off-chain UI to display score progression over time.
- Audits to verify that each point corresponds to a ledger event.

However, **the on-chain Reputation contract does not store history** — only the current score. To recover a historical timeline, systems must replay events from the ledger.

### Score Freezes on Revocation

If a circle is revoked:

1. It can no longer call `increment`.
2. The member's current score is frozen.
3. No points awarded by that circle before revocation are removed or adjusted.
4. The member's score remains visible and unchanged forever.

## Limitations and Non-Guarantees

### Not a Credit Decision

The reputation score **does not** indicate:

- Whether a user will default on future commitments.
- Financial creditworthiness or ability to repay.
- Trustworthiness outside the ROSCA context.
- Moral or character judgment.

**It only means:** This wallet has completed X circle rounds in the past.

### Limited Time Span

- A member who completed circles in 2023 has a permanently elevated score, even if they have not participated in any circles recently.
- The score contains no expiration logic — it does not decay or reset.
- A wallet with historical score but no recent activity will still display its badge, which may mislead users about current reliability.

### Incomplete Member Data

- A member with **zero score** may be:
  - Genuinely new (never completed a circle).
  - A participant in one circle that failed mid-way (no payout reached).
  - A wallet that lost or rotated its key after participation.
  - A participant in an un-indexed or off-chain circle.

**The score does not distinguish between these scenarios.**

### Single-Chain Scope

The reputation score reflects activity on a single Soroban network (mainnet, testnet, etc.). A user active on multiple blockchains will have separate scores on each, and the UI only displays the score for the queried chain.

### Missing Historical Context

The score is a single number. The UI does not show:

- When the member's latest point was awarded.
- How long ago they completed their most recent circle.
- How many circles they have *attempted* (only completed ones count).
- Whether their circles are ongoing or completed.

A member might have score 5 from five circles completed years ago, or from five circles completed this week — the score alone does not distinguish.

### Not Reversible

- Points are never removed or decremented.
- If a member leaves a circle early or misses rounds, their score does not go down.
- If a circle is cancelled or fails, the member retains any points they earned in completed rounds up to that point.

## Display and Interpretation

### Badge Semantics

The ReputationBadge component displays five tiers:

| Level | Range | Meaning |
|-------|-------|---------|
| **New** | 0 points | No completed rounds yet |
| **Starter** | 1–2 points | Just getting started |
| **Reliable** | 3–5 points | Building a track record |
| **Trusted** | 6–9 points | Proven track record |
| **Legend** | 10+ points | Very high participation |

Each tier is communicated via:

1. **Color** — visual background and text color.
2. **Marker** — a shape (○ ◔ ◑ ◕ ●) for non-color distinction.
3. **Label** — the tier name (visible and in aria-label).
4. **Emoji** — a recognizable icon (🌱 ⭐ 💎 🏆 👑).
5. **Numeric score** — the exact point count.

**All communication channels together prevent relying on color alone.**

### What Users Should Understand

Users should be told:

- "This score counts how many ROSCA circles you have completed."
- "One point = one completed circle."
- "Your score only goes up (it never decreases or resets)."
- "This score is **not** a credit rating or personal guarantee."
- "A higher score means you have shown up reliably in circles before — that's all."

### What Users Should Not Infer

Users should **not** interpret the score as:

- A loan eligibility prediction.
- A character endorsement or safety certification.
- An indication that this wallet will participate in *future* circles reliably.
- A general measure of trustworthiness outside of ROSCAs.
- A guarantee that this wallet will not default.

## Contract-Indexer Alignment

The on-chain Reputation contract and the indexer must agree on score semantics:

### Contract Guarantees

- `score(member)` returns the member's current total score (u32).
- `increment(circle, member)` adds 1 and emits `score_updated(member, new_score)`.
- Increments are rejected if the circle is not authorized or is revoked.
- Scores are monotonically increasing (never decrement).

### Indexer Responsibility

- Parse `reputation/score_updated` events from every finalized ledger.
- Store (member, score, ledger_sequence, timestamp) tuples so historical queries work.
- Verify that the indexed score matches the on-chain score when queried.
- Expose score history via API so frontends can show progression if desired.

If the indexer's data diverges from the contract, **the contract is the source of truth**. Frontends should always be able to fall back to direct contract queries for current scores.

## Testing and Verification

### Recommended Checks

- **Zero-score member:** Verify that a member with no score displays as "New" and can join and complete a circle.
- **Missing history:** Verify that a member with missing indexer history but a non-zero on-chain score still displays the correct badge.
- **Active member:** Verify that a member actively completing circles sees their score increment in real time or within one indexer sync cycle.
- **Revoked circle:** Verify that a member's score stays frozen even if their old circle is marked as compromised and revoked.

## References

- Reputation contract: `contracts/reputation/src/lib.rs`
- Score increment trigger: Circle payout logic (`contracts/circle/src/lib.rs`)
- Events specification: `docs/EVENTS.md` — `reputation/score_updated` payload format
- Authorization model: `contracts/reputation/src/lib.rs` — trust boundary and allowlist docs
- Issue #686: Explain reputation score meaning and limitations
