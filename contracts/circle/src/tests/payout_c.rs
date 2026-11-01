use super::*;

    fn test_payout_counter_ahead_of_keys_triggers_tally_mismatch() {
        let t = setup_circle();
        t.activate();

        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.circle.contribute(&t.carol);
        // Dave has NOT contributed — 3 keys exist

        // Forge the counter to 4 so the first payout guard passes but the
        // second (key-based) tally check must still catch the discrepancy.
        t.env.as_contract(&t.circle_id, || {
            let mut round: crate::RoundState = t
                .env
                .storage()
                .instance()
                .get(&crate::DataKey::CurrentRound)
                .unwrap();
            round.contributions_received = 4;
            t.env
                .storage()
                .instance()
                .set(&crate::DataKey::CurrentRound, &round);
        });

        t.circle.payout(); // must panic: tally mismatch (3 keys, counter says 4)
    }

    // ── Multi-default across rounds ───────────────────────────────────────────

    /// A member who defaults in round 0 can also default in round 1.  Each
    /// default increments the counter and deducts collateral, and the
    /// `Defaulted` keys for each round are independent.
    #[test]
    fn test_member_can_default_in_multiple_rounds() {
        let t = setup_circle();
        t.activate();

        // Round 0: alice and bob contribute; carol and dave default
        t.circle.contribute(&t.alice);
        t.circle.contribute(&t.bob);
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);

        let collateral_after_r0 = t.circle.get_collateral(&t.carol);
        assert_eq!(t.circle.get_defaults(&t.carol), 1);

        // We cannot proceed to round 1 without completing round 0.
        // Contribute for carol and dave to unblock payout (they already defaulted
        // but can still contribute after the deadline — wait, they cannot because
        // deadline has passed).  We need a different approach: force both carol
        // and dave contributions to allow payout.
        t.force_contributed(&t.carol, 0);
        t.force_contributed(&t.dave, 0);

        // Manually bump the contributions_received counter to 4
        t.env.as_contract(&t.circle_id, || {
            let mut round: crate::RoundState = t
                .env
                .storage()
                .instance()
                .get(&crate::DataKey::CurrentRound)
                .unwrap();
            round.contributions_received = 4;
            t.env
                .storage()
                .instance()
                .set(&crate::DataKey::CurrentRound, &round);
        });

        t.circle.payout(); // complete round 0

        // Round 1 starts; advance past its deadline
        let round1 = t.circle.get_current_round();
        t.env.ledger().with_mut(|l| {
            l.sequence_number = round1.deadline_ledger as u32 + 1;
        });

        // Carol defaults again in round 1
        t.circle.mark_default(&t.carol);

        assert_eq!(t.circle.get_defaults(&t.carol), 2, "carol should have 2 defaults");
        assert!(
            t.circle.get_collateral(&t.carol) < collateral_after_r0,
            "collateral must decrease further after second default"
        );
        assert!(t.has_defaulted_key(&t.carol, 0));
        assert!(t.has_defaulted_key(&t.carol, 1));
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #166 — Re-architect close as strict settlement with lifecycle
    // invariants and idempotency guard.
    //
    // Tests in this section cover:
    //   • Terminal-state preconditions (Pending rejection, Active rejection)
    //   • Duplicate-close rejection via DataKey::Closed flag
    //   • Partial-default penalty histories and correct reduced-amount release
    //   • Zero-collateral member handling (no event, no transfer)
    //   • Arithmetic reconciliation: sum(collateral_released) == total_released
    //   • is_closed() view before and after settlement
    // ══════════════════════════════════════════════════════════════════════════

    // ── Pending rejection ─────────────────────────────────────────────────────

    /// close() on a circle still in Pending state must panic with a message
    /// that distinguishes it from the Active case so callers receive an
    /// actionable diagnostic.
    #[test]
    fn test_close_rejected_while_pending() {
        let t = setup_circle();
        assert_eq!(t.circle.get_status(), CircleStatus::Pending);
        assert_eq!(
            t.circle.try_close(&t.alice),
            Err(Ok(CloseError::NotTerminalState)),
            "close must return NotTerminalState while Pending"
        );
    }

    // ── Duplicate-close rejection ─────────────────────────────────────────────

    /// After a successful close the DataKey::Closed flag is set.  Any subsequent
    /// invocation — even by a different member — must be rejected immediately so
    /// no partial-release state can accumulate across calls.
    #[test]
    fn test_close_already_closed_panics() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        assert!(!t.circle.is_closed(), "is_closed must be false before first close");
        t.circle.close(&t.alice);
        assert!(t.circle.is_closed(), "is_closed must be true after first close");

        assert_eq!(
            t.circle.try_close(&t.dave),
            Err(Ok(CloseError::AlreadyClosed)),
            "re-invocation must return AlreadyClosed"
        );
    }

    // ── is_closed view ────────────────────────────────────────────────────────

    /// is_closed() must return false on an initialized but not-yet-closed circle
    /// and true after close() completes.
    #[test]
    fn test_is_closed_transitions_correctly() {
        let t = setup_circle();
        assert!(!t.circle.is_closed(), "uninitialized-close circle must report is_closed = false");

        t.activate();
        t.complete_all_rounds();
        assert!(!t.circle.is_closed(), "completed but not-yet-closed circle must report false");

        t.circle.close(&t.carol);
        assert!(t.circle.is_closed(), "after close() is_closed must return true");
    }

    #[test]
    fn test_is_closed_false_for_cancelled_before_close() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);
        assert!(!t.circle.is_closed(), "cancelled-but-not-closed circle must report false");

        t.circle.close(&t.alice);
        assert!(t.circle.is_closed());
    }

    // ── Partial-default penalty histories ─────────────────────────────────────

    /// When some members have been marked default one or more times their
    /// collateral is reduced by the penalty.  close() must release only the
    /// remaining balance — not the original full-collateral amount.
    #[test]
    fn test_close_with_partial_default_returns_reduced_collateral() {
        let t = setup_circle();
        t.activate();

        // Apply one default penalty to carol
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);

        let carol_collateral_after_penalty = t.circle.get_collateral(&t.carol);
        let expected_penalty = ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM;
        let expected_carol_balance = ROUND_AMOUNT - expected_penalty;
        assert_eq!(carol_collateral_after_penalty, expected_carol_balance);

        // Force to Completed so close() is accepted (also aligns RoundsCompleted)
        t.force_status(CircleStatus::Completed);

        let carol_wallet_before = t.token.balance(&t.carol);
        t.circle.close(&t.alice);
        let carol_wallet_after = t.token.balance(&t.carol);

        // Carol receives only the post-penalty remainder, not the full collateral
        assert_eq!(
            carol_wallet_after - carol_wallet_before,
            expected_carol_balance,
            "close must release only remaining (post-penalty) collateral for defaulted member"
        );
        assert_eq!(t.circle.get_collateral(&t.carol), 0);
    }

    /// After two defaults the collateral is reduced twice.  close() must release
    /// the doubly-reduced balance and emit a collateral_released event carrying
    /// that exact amount.
    #[test]
    fn test_close_with_two_defaults_releases_doubly_reduced_collateral() {
        let t = setup_circle();
        t.activate();

        let initial_collateral = t.circle.get_collateral(&t.bob);

        // Round 0: bob defaults
        t.advance_past_deadline();
        t.circle.mark_default(&t.bob);
        let after_first_default = t.circle.get_collateral(&t.bob);

        // Round 1: simulate bob defaulting again by forcing round state + advancing
        // Advance to a new round by forcing round index to 1 and a new deadline
        t.env.as_contract(&t.circle_id, || {
            let mut round: crate::RoundState = t
                .env
                .storage()
                .instance()
                .get(&crate::DataKey::CurrentRound)
                .unwrap();
            round.round_index = 1;
            round.paid_out = false;
            round.deadline_ledger = t.env.ledger().sequence() as u64 + 1;
            t.env.storage().instance().set(&crate::DataKey::CurrentRound, &round);
        });
        t.env.ledger().with_mut(|l| {
            l.sequence_number += 2;
        });
        t.circle.mark_default(&t.bob);
        let after_second_default = t.circle.get_collateral(&t.bob);

        // Sanity: each default reduced collateral by 20%
        let first_penalty = initial_collateral * PENALTY_BPS / BPS_DENOM;
        assert_eq!(after_first_default, initial_collateral - first_penalty);
        let second_penalty = after_first_default * PENALTY_BPS / BPS_DENOM;
        assert_eq!(after_second_default, after_first_default - second_penalty);

        // Force terminal state (also aligns RoundsCompleted)
        t.force_status(CircleStatus::Completed);

        let bob_wallet_before = t.token.balance(&t.bob);
        t.circle.close(&t.alice);
        let bob_wallet_after = t.token.balance(&t.bob);

        assert_eq!(
            bob_wallet_after - bob_wallet_before,
            after_second_default,
            "close must release doubly-reduced collateral"
        );
    }

    // ── Zero-balance member handling ──────────────────────────────────────────

    /// A member whose collateral has been completely drained to zero by repeated
    /// penalties must not receive any transfer.  The remaining members still get
    /// their correct amounts and the total_released reflects only non-zero balances.
    #[test]
    fn test_close_zero_balance_member_no_transfer() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        // Drain dave's collateral to zero (simulates repeated penalty drain)
        t.force_collateral(&t.dave, 0i128);

        let dave_wallet_before = t.token.balance(&t.dave);
        let alice_wallet_before = t.token.balance(&t.alice);
        let bob_wallet_before = t.token.balance(&t.bob);
        let carol_wallet_before = t.token.balance(&t.carol);

        t.circle.close(&t.alice);

        // Dave must receive nothing — zero balance, no transfer
        assert_eq!(
            t.token.balance(&t.dave), dave_wallet_before,
            "zero-balance member must not receive any tokens on close"
        );
        // Other members still receive their collateral
        assert_eq!(
            t.token.balance(&t.alice) - alice_wallet_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "alice must receive full collateral"
        );
        assert_eq!(
            t.token.balance(&t.bob) - bob_wallet_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
        );
        assert_eq!(
            t.token.balance(&t.carol) - carol_wallet_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
        );
        // Dave's collateral key remains at 0
        assert_eq!(t.circle.get_collateral(&t.dave), 0);
    }

    /// A member who never joined (no Collateral key) must be silently skipped
    /// during settlement — no transfer, collateral storage key stays absent.
    #[test]
    fn test_close_cancelled_partial_join_skips_non_joined_members() {
        let t = setup_circle();
        // Only alice and bob join; carol cancels (without joining); dave never interacts
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.cancel(&t.carol);

        let carol_before = t.token.balance(&t.carol);
        let dave_before = t.token.balance(&t.dave);
        let alice_before = t.token.balance(&t.alice);
        let bob_before = t.token.balance(&t.bob);

        t.circle.close(&t.alice);

        // Non-joined members receive nothing
        assert_eq!(t.token.balance(&t.carol), carol_before,
            "carol (never joined) must not receive tokens on close");
        assert_eq!(t.token.balance(&t.dave), dave_before,
            "dave (never joined) must not receive tokens on close");

        // Joined members receive their collateral back
        assert_eq!(
            t.token.balance(&t.alice) - alice_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
        );
        assert_eq!(
            t.token.balance(&t.bob) - bob_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
        );

        // Joined members' storage keys are zeroed
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
        assert_eq!(t.circle.get_collateral(&t.bob), 0);
    }

    // ── Arithmetic reconciliation ─────────────────────────────────────────────

    /// The sum of all pre-close member collateral values must equal total_released
    /// in the aggregate closed event.
    ///
    /// This is the storage-level reconciliation invariant: read collateral from
    /// storage before close, then verify the closed event reports the same total.
    /// Any member that is double-released or silently skipped will break this.
    #[test]
    fn test_close_total_released_matches_collateral_sum_from_storage() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        // Apply a reduced collateral to carol to create a non-uniform distribution
        let penalty = ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM;
        t.force_collateral(&t.carol, ROUND_AMOUNT - penalty);

        // Read all collateral values from storage before close
        let pre_close_sum: i128 = [&t.alice, &t.bob, &t.carol, &t.dave]
            .iter()
            .map(|m| t.circle.get_collateral(m))
            .sum();

        // Flush and close
        let _ = t.env.events().all();
        t.circle.close(&t.alice);

        // Decode total_released from the closed event
        let closed_events = events_named(&t.env, "closed");
        assert_eq!(closed_events.len(), 1, "expected exactly one closed event");
        let closed_data = closed_events[0].clone();
        let (_circle, _closer, total_released, _total_expected, _reason): (Address, Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_data);

        assert_eq!(
            total_released, pre_close_sum,
            "total_released in closed event must equal the sum of pre-close collateral balances"
        );
        // After close all storage keys are zeroed
        for m in [&t.alice, &t.bob, &t.carol, &t.dave] {
            assert_eq!(t.circle.get_collateral(m), 0);
        }
    }

    /// The closed event total_expected_collateral field must equal
    /// member_count × round_amount × COLLATERAL_MULTIPLIER regardless of any
    /// penalties applied, so auditors can compute total forfeiture as
    /// total_expected − total_released.
    #[test]
    fn test_close_event_total_expected_matches_full_collateral() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        let _ = t.env.events().all();
        t.circle.close(&t.alice);

        // Collect all events at once so we don't clear the buffer mid-assertion
        let all_events = t.env.events().all();
        let closed_data = all_events
            .iter()
            .find(|(_c, topics, _d)| {
                topics.get(1).map(|v| {
                    let s = soroban_sdk::Symbol::new(&t.env, "closed");
                    let sv: soroban_sdk::Val =
                        soroban_sdk::IntoVal::<Env, soroban_sdk::Val>::into_val(&s, &t.env);
                    soroban_sdk::Val::get_payload(v) == soroban_sdk::Val::get_payload(sv)
                }).unwrap_or(false)
            })
            .map(|(_c, _t, d)| d.clone())
            .expect("expected a closed event");

        let (_circle, _closer, _total_released, total_expected, _reason): (Address, Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_data);

        let expected = ROUND_AMOUNT * COLLATERAL_MULTIPLIER * (t.members.len() as i128);
        assert_eq!(
            total_expected, expected,
            "closed event total_expected_collateral must equal member_count × round_amount × COLLATERAL_MULTIPLIER"
        );
    }

    /// When no penalties were applied total_released must exactly equal
    /// total_expected_collateral — every member gets back their full collateral.
    #[test]
