use super::*;

    fn test_close_no_penalties_total_released_equals_total_expected() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        let _ = t.env.events().all();
        t.circle.close(&t.alice);

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

        let (_circle, _closer, total_released, total_expected, _reason): (Address, Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_data);

        assert_eq!(
            total_released, total_expected,
            "without penalties total_released must equal total_expected_collateral"
        );
    }

    /// Arithmetic invariant for Cancelled circles: total released must equal the
    /// sum of collateral locked by the members who actually joined.
    #[test]
    fn test_close_cancelled_total_released_matches_joined_collateral() {
        let t = setup_circle();
        // Only alice and bob join
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.cancel(&t.carol);

        let expected_total = ROUND_AMOUNT * COLLATERAL_MULTIPLIER * 2; // only 2 joined

        let _ = t.env.events().all();
        t.circle.close(&t.alice);

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

        let (_circle, _closer, total_released, _total_expected, _reason): (Address, Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_data);

        assert_eq!(
            total_released, expected_total,
            "cancelled circle total_released must equal collateral from joined members only"
        );
    }

    // ── Completed-invariant check ─────────────────────────────────────────────

    /// close() must verify that RoundsCompleted == member_count when status is
    /// Completed, guarding against a hypothetical state corruption.
    /// If the count is wrong the function must panic with a storage-inconsistency
    /// message rather than silently releasing collateral in a bad state.
    #[test]
    fn test_close_completed_invariant_rejects_incomplete_rounds() {
        let t = setup_circle();
        t.activate();

        t.env.as_contract(&t.circle_id, || {
            t.env
                .storage()
                .instance()
                .set(&DataKey::Status, &CircleStatus::Completed);
        });

        assert_eq!(
            t.circle.try_close(&t.alice),
            Err(Ok(CloseError::RoundsIncomplete)),
            "close must return RoundsIncomplete for corrupted Completed state"
        );
    }

    // ── Contribute rejects non-member ─────────────────────────────────────────

    #[test]
    #[should_panic]
    fn test_contribute_by_non_member_panics() {
        let t = setup_circle();
        t.activate();
        let outsider = Address::generate(&t.env);
        t.circle.contribute(&outsider);
    }

    // ── mark_default rejects non-member ───────────────────────────────────────

    #[test]
    #[should_panic]
    fn test_mark_default_of_non_member_panics() {
        let t = setup_circle();
        t.activate();
        t.advance_past_deadline();
        let outsider = Address::generate(&t.env);
        t.circle.mark_default(&outsider);
    }

    // ── Contribute rejected on Pending circle ─────────────────────────────────

    #[test]
    #[should_panic]
    fn test_contribute_on_pending_circle_panics() {
        let t = setup_circle();
        // Only 2 of 4 members join — circle stays Pending
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.contribute(&t.alice);
    }

    // ── Payout on Pending circle ──────────────────────────────────────────────

    #[test]
    #[should_panic]
    fn test_payout_on_pending_circle_panics() {
        let t = setup_circle();
        t.circle.payout();
    }

    // ── Payout on Completed circle ────────────────────────────────────────────

    #[test]
    #[should_panic]
    fn test_payout_on_completed_circle_panics() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        t.circle.payout();
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Issue #179 — Rework collateral release and close semantics for terminal
    // states.
    //
    // Tests in this section explicitly cover every acceptance criterion from
    // the issue:
    //
    //   • The contract rejects close() while the circle is Active or Pending.
    //   • Each member's remaining collateral is returned exactly once; no
    //     balance is skipped or double-transferred.
    //   • The release procedure emits a terminal settlement sequence that
    //     off-chain consumers can reconcile without ambiguity.
    //   • Repeated close() attempts leave no partial release state behind.
    //   • Arithmetic assertion: sum(collateral_released events) ==
    //     total_released in the closed event == pre-release storage sum.
    // ══════════════════════════════════════════════════════════════════════════

    // ── Terminal-state precondition enforcement ───────────────────────────────

    /// close() on an Active circle must return CloseError::NotTerminalState.
    #[test]
    fn test_179_close_rejected_on_active_circle() {
        let t = setup_circle();
        t.activate();
        assert_eq!(
            t.circle.try_close(&t.alice),
            Err(Ok(CloseError::NotTerminalState)),
            "close must return NotTerminalState on Active circle"
        );
    }

    /// close() on a Pending circle must return CloseError::NotTerminalState.
    #[test]
    fn test_179_close_rejected_on_pending_circle() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        assert_eq!(
            t.circle.try_close(&t.alice),
            Err(Ok(CloseError::NotTerminalState)),
            "close must return NotTerminalState on Pending circle"
        );
    }

    // ── Completed-circle full settlement ─────────────────────────────────────

    /// After a full-lifecycle run (all rounds completed) close() must return
    /// every member's collateral exactly once and zero every storage key.
    #[test]
    fn test_179_close_completed_returns_each_member_collateral_once() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();
        assert_eq!(t.circle.get_status(), CircleStatus::Completed);

        let expected = ROUND_AMOUNT * COLLATERAL_MULTIPLIER;

        let alice_before = t.token.balance(&t.alice);
        let bob_before   = t.token.balance(&t.bob);
        let carol_before = t.token.balance(&t.carol);
        let dave_before  = t.token.balance(&t.dave);

        t.circle.close(&t.alice);

        // Every member receives exactly their collateral back
        assert_eq!(t.token.balance(&t.alice) - alice_before, expected, "alice collateral mismatch");
        assert_eq!(t.token.balance(&t.bob)   - bob_before,   expected, "bob collateral mismatch");
        assert_eq!(t.token.balance(&t.carol) - carol_before, expected, "carol collateral mismatch");
        assert_eq!(t.token.balance(&t.dave)  - dave_before,  expected, "dave collateral mismatch");

        // Storage keys are zeroed for all members
        assert_eq!(t.circle.get_collateral(&t.alice), 0);
        assert_eq!(t.circle.get_collateral(&t.bob),   0);
        assert_eq!(t.circle.get_collateral(&t.carol), 0);
        assert_eq!(t.circle.get_collateral(&t.dave),  0);

        // is_closed() reports true
        assert!(t.circle.is_closed());
    }

    // ── Cancelled-circle settlement ───────────────────────────────────────────

    /// close() on a Cancelled circle must return collateral only to members who
    /// actually joined.  Members who never called join() have no Collateral key
    /// and must be silently skipped with no transfer.
    #[test]
    fn test_179_close_cancelled_returns_only_joined_member_collateral() {
        let t = setup_circle();
        // Only alice and bob join before the circle is cancelled
        t.circle.join(&t.alice);
        t.circle.join(&t.bob);
        t.circle.cancel(&t.carol); // any member can cancel a Pending circle
        assert_eq!(t.circle.get_status(), CircleStatus::Cancelled);

        let expected_per_joined = ROUND_AMOUNT * COLLATERAL_MULTIPLIER;

        let alice_before = t.token.balance(&t.alice);
        let bob_before   = t.token.balance(&t.bob);
        let carol_before = t.token.balance(&t.carol);
        let dave_before  = t.token.balance(&t.dave);

        t.circle.close(&t.alice);

        // Alice and bob (joined) get their collateral back
        assert_eq!(t.token.balance(&t.alice) - alice_before, expected_per_joined);
        assert_eq!(t.token.balance(&t.bob)   - bob_before,   expected_per_joined);

        // Carol and dave (never joined) receive nothing
        assert_eq!(t.token.balance(&t.carol), carol_before, "carol must not receive tokens");
        assert_eq!(t.token.balance(&t.dave),  dave_before,  "dave must not receive tokens");

        assert!(t.circle.is_closed());
    }

    // ── Partial-default settlement ────────────────────────────────────────────

    /// When some members have been penalised via mark_default the remaining
    /// collateral at close time is less than the initial deposit.  close() must
    /// release only the reduced balance for each defaulting member — not the
    /// original full-collateral amount.
    #[test]
    fn test_179_close_partial_default_releases_reduced_collateral() {
        let t = setup_circle();
        t.activate();

        // Penalise carol (one default → 20 % penalty deducted)
        t.advance_past_deadline();
        t.circle.mark_default(&t.carol);

        let carol_collateral_after_penalty = t.circle.get_collateral(&t.carol);
        let expected_penalty = ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM;
        assert_eq!(carol_collateral_after_penalty, ROUND_AMOUNT - expected_penalty,
            "pre-close carol collateral must reflect the single penalty deduction");

        // Force terminal state so close() is accepted
        t.force_status(CircleStatus::Completed);

        let carol_before = t.token.balance(&t.carol);
        t.circle.close(&t.alice);

        // Carol receives only the post-penalty remainder
        assert_eq!(
            t.token.balance(&t.carol) - carol_before,
            carol_collateral_after_penalty,
            "close must release the post-penalty remainder, not the full collateral"
        );
        assert_eq!(t.circle.get_collateral(&t.carol), 0, "carol storage key must be zeroed");
    }

    // ── Zero-balance member handling ──────────────────────────────────────────

    /// A member whose collateral has been entirely drained to zero by repeated
    /// penalties must not receive any token transfer on close().  The zero-balance
    /// member should neither cause a panic nor produce a collateral_released event.
    #[test]
    fn test_179_close_zero_balance_member_skipped() {
        let t = setup_circle();
        t.activate();
        t.force_status(CircleStatus::Completed);

        // Drain dave's collateral to zero (simulates full penalty exhaustion)
        t.force_collateral(&t.dave, 0i128);

        let dave_before = t.token.balance(&t.dave);
        let alice_before = t.token.balance(&t.alice);

        let _ = t.env.events().all(); // flush earlier events
        t.circle.close(&t.alice);

        // Dave receives no tokens — zero balance, no transfer
        assert_eq!(
            t.token.balance(&t.dave), dave_before,
            "zero-balance member must not receive any tokens"
        );
        // Dave's storage key remains at 0 (not created if absent, stays 0 if present)
        assert_eq!(t.circle.get_collateral(&t.dave), 0);

        // Other members (with positive balance) still receive their collateral
        assert_eq!(
            t.token.balance(&t.alice) - alice_before,
            ROUND_AMOUNT * COLLATERAL_MULTIPLIER,
            "non-zero-balance members must still receive their collateral"
        );

        // No collateral_released event for dave; three events for the other members
        let released = events_named(&t.env, "collateral_released");
        assert_eq!(released.len(), 3, "expected collateral_released events only for members with positive balance");
    }

    // ── Duplicate close rejection ─────────────────────────────────────────────

    /// After a successful close() any subsequent invocation — by any member —
    /// must be rejected with "circle already closed".  No partial-release state
    /// must accumulate across calls.
    #[test]
    fn test_179_duplicate_close_panics() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        t.circle.close(&t.alice);
        assert!(t.circle.is_closed(), "is_closed must be true after first close");

        assert_eq!(
            t.circle.try_close(&t.dave),
            Err(Ok(CloseError::AlreadyClosed)),
            "subsequent close must return AlreadyClosed"
        );
    }

    /// A duplicate close attempt after a Cancelled-circle settlement must also
    /// be rejected.
    #[test]
    fn test_179_duplicate_close_after_cancel_panics() {
        let t = setup_circle();
        t.circle.join(&t.alice);
        t.circle.cancel(&t.alice);

        t.circle.close(&t.alice);
        assert_eq!(
            t.circle.try_close(&t.bob),
            Err(Ok(CloseError::AlreadyClosed)),
            "second close after cancel must return AlreadyClosed"
        );
    }

    // ── Arithmetic assertion: sum(collateral_released) == total_released ──────

    /// The sum of all per-member collateral_released event payloads must equal
    /// the total_released field in the aggregate closed event, and both must
    /// equal the pre-close sum of all Collateral storage keys.
    ///
    /// This is the core arithmetic reconciliation test from issue #179 —
    /// it validates that the on-chain settlement assertion fires correctly for
    /// the nominal (no-error) path, and that the event log gives auditors a
    /// consistent, reconcilable view of the settlement.
    #[test]
    fn test_179_arithmetic_reconciliation_released_equals_storage_sum() {
        let t = setup_circle();
        t.activate();
        t.complete_all_rounds();

        // Apply a penalty to bob to create a non-uniform distribution
        let penalty = ROUND_AMOUNT * PENALTY_BPS / BPS_DENOM;
        t.force_collateral(&t.bob, ROUND_AMOUNT - penalty);

        // Read all collateral values from storage before close
        let pre_close_sum: i128 = [&t.alice, &t.bob, &t.carol, &t.dave]
            .iter()
            .map(|m| t.circle.get_collateral(m))
            .sum();

        let _ = t.env.events().all(); // flush earlier events
        t.circle.close(&t.alice);

        // Decode the aggregate closed event
        let closed_events = events_named(&t.env, "closed");
        assert_eq!(closed_events.len(), 1, "expected exactly one closed event");
        let (_circle, _closer, total_released, _total_expected, _reason): (Address, Address, i128, i128, soroban_sdk::Symbol) =
            soroban_sdk::FromVal::from_val(&t.env, &closed_events[0]);

        // 1. total_released must equal the pre-close storage sum
        assert_eq!(
            total_released, pre_close_sum,
            "total_released must equal the pre-close sum of all Collateral storage values"
        );

        // 2. Sum of collateral_released event payloads must also equal total_released
        let released_events = events_named(&t.env, "collateral_released");
        let events_sum: i128 = released_events
            .iter()
            .map(|v| {
                let (_circle, _member, amount): (Address, Address, i128) =
                    soroban_sdk::FromVal::from_val(&t.env, v);
                amount
            })
            .sum();
        assert_eq!(
            events_sum, total_released,
            "sum of collateral_released events must equal total_released in the closed event"
        );

        // 3. All storage keys are zeroed after settlement
        for m in [&t.alice, &t.bob, &t.carol, &t.dave] {
            assert_eq!(t.circle.get_collateral(m), 0, "post-close collateral must be 0 for all members");
        }
    }

    /// The closed event reason field must be "completed" for a Completed circle
    /// and "cancelled" for a Cancelled circle.  Off-chain consumers use this
    /// field to differentiate settlement types without re-reading circle status.
    #[test]
