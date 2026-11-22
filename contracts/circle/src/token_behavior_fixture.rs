//! Reusable token-behavior fixture for cross-contract transfer tests (issue #888).
//!
//! CircleUp only relies on the standard SEP-41 surface (balance, transfer and
//! the SAC trustline flags). These modes model every token outcome the
//! contracts must handle without inventing non-standard token semantics:
//!
//! | Mode | Payer-side setup | Recipient-side setup |
//! |------|------------------|----------------------|
//! | [`TokenBehavior::Success`] | funded, authorized | funded, authorized |
//! | [`TokenBehavior::InsufficientFunds`] | wallet balance burned | circle balance drained |
//! | [`TokenBehavior::AuthorizationRejected`] | trustline deauthorized | trustline deauthorized + balance drained |
//! | [`TokenBehavior::ExplicitTransferFailure`] | both of the above | both of the above |
//!
//! Outbound modes also drain the circle balance so the failure is deterministic
//! even if a token implementation does not check destination authorization.
//! The underlying double is the real Stellar Asset Contract registered by
//! [`test_support::FixtureBuilder`], not a hand-written mock. Facts about the
//! deployed mainnet USDC contract (issuer identity, reserve backing, clawback
//! policy) are deliberately documented separately in
//! `docs/USDC_ASSUMPTIONS.md`; this fixture proves only how CircleUp reacts to
//! standard token success and failure outcomes.

#![cfg(test)]
extern crate std;

use crate::test_support::{fixture, Fixture, COLLATERAL, ROUND_AMOUNT};
use soroban_sdk::{Address, FromVal, Symbol};

/// A deterministic, named token outcome applied by [`TokenScenario`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenBehavior {
    Success,
    InsufficientFunds,
    AuthorizationRejected,
    ExplicitTransferFailure,
}

impl TokenBehavior {
    /// Every mode, so a single test body can cover all transfer outcomes.
    pub const ALL: [TokenBehavior; 4] = [
        TokenBehavior::Success,
        TokenBehavior::InsufficientFunds,
        TokenBehavior::AuthorizationRejected,
        TokenBehavior::ExplicitTransferFailure,
    ];

    /// Whether this mode must make the token transfer fail.
    pub fn fails(self) -> bool {
        self != TokenBehavior::Success
    }
}

/// Restoration token for a payer-side setup returned by
/// [`TokenScenario::prepare_payer`].
#[derive(Clone, Copy, Debug, Default)]
pub struct PayerState {
    pub burned: i128,
}

/// Restoration token for a recipient-side setup returned by
/// [`TokenScenario::prepare_recipient`].
#[derive(Clone, Debug, Default)]
pub struct RecipientState {
    pub drained: Option<(Address, i128)>,
}

/// A circle fixture with one explicitly selected token behavior.
pub struct TokenScenario<'a> {
    pub t: Fixture<'a>,
    pub behavior: TokenBehavior,
}

impl TokenScenario<'static> {
    /// Build a fresh circle whose token double behaves as `behavior`.
    pub fn new(behavior: TokenBehavior) -> Self {
        Self {
            t: fixture(),
            behavior,
        }
    }

    /// Make `member` unable to send a standard token transfer to the circle.
    pub fn prepare_payer(&self, member: &Address) -> PayerState {
        let mut state = PayerState::default();
        match self.behavior {
            TokenBehavior::Success => {}
            TokenBehavior::InsufficientFunds => {
                state.burned = self.t.empty_wallet(member);
            }
            TokenBehavior::AuthorizationRejected => {
                self.t.asset.set_authorized(member, &false);
            }
            TokenBehavior::ExplicitTransferFailure => {
                self.t.asset.set_authorized(member, &false);
                state.burned = self.t.empty_wallet(member);
            }
        }
        state
    }

    /// Undo [`Self::prepare_payer`] so the same call can be retried.
    pub fn restore_payer(&self, member: &Address, state: PayerState) {
        self.t.asset.set_authorized(member, &true);
        if state.burned > 0 {
            self.t.asset.mint(member, &state.burned);
        }
    }

    /// Make the circle unable to complete an outgoing transfer to `recipient`.
    pub fn prepare_recipient(&self, recipient: &Address) -> RecipientState {
        let mut state = RecipientState::default();
        match self.behavior {
            TokenBehavior::Success => {}
            TokenBehavior::InsufficientFunds => {
                state.drained = self.drain_circle();
            }
            TokenBehavior::AuthorizationRejected => {
                self.t.asset.set_authorized(recipient, &false);
                state.drained = self.drain_circle();
            }
            TokenBehavior::ExplicitTransferFailure => {
                self.t.asset.set_authorized(recipient, &false);
                state.drained = self.drain_circle();
            }
        }
        state
    }

    /// Undo [`Self::prepare_recipient`] so the same call can be retried.
    pub fn restore_recipient(&self, recipient: &Address, state: RecipientState) {
        self.t.asset.set_authorized(recipient, &true);
        if let Some((sink, amount)) = state.drained {
            self.t.refund_circle(&sink, amount);
        }
    }

    fn drain_circle(&self) -> Option<(Address, i128)> {
        let held = self.t.token.balance(&self.t.circle_id);
        if held > 0 {
            Some((self.t.drain_circle(held), held))
        } else {
            None
        }
    }
}

fn event_names(
    s: &TokenScenario<'_>,
    events: &std::vec::Vec<(soroban_sdk::Vec<soroban_sdk::Val>, soroban_sdk::Val)>,
) -> std::vec::Vec<std::string::String> {
    events
        .iter()
        .map(|(topics, _)| {
            std::format!("{:?}", Symbol::from_val(&s.t.env, &topics.get(1).unwrap()))
        })
        .collect()
}

#[test]
fn join_transfer_modes_never_leave_partial_state() {
    for behavior in TokenBehavior::ALL {
        let s = TokenScenario::new(behavior);
        let state = s.prepare_payer(&s.t.alice);
        let result = s.t.circle.try_join(&s.t.alice);

        if behavior.fails() {
            assert!(result.is_err(), "join must fail for {behavior:?}");
            assert_eq!(s.t.circle.get_collateral(&s.t.alice), 0);
            assert_eq!(s.t.token.balance(&s.t.circle_id), 0);
        } else {
            assert!(result.is_ok(), "join must succeed for {behavior:?}");
            assert_eq!(s.t.circle.get_collateral(&s.t.alice), COLLATERAL);
        }

        s.restore_payer(&s.t.alice, state);
        if behavior.fails() {
            s.t.circle.join(&s.t.alice);
        }
        assert_eq!(s.t.circle.get_collateral(&s.t.alice), COLLATERAL);
        assert_eq!(s.t.token.balance(&s.t.circle_id), COLLATERAL);
    }
}

#[test]
fn contribution_transfer_modes_never_leave_partial_state() {
    for behavior in TokenBehavior::ALL {
        let s = TokenScenario::new(behavior);
        s.t.join_all();
        let state = s.prepare_payer(&s.t.alice);
        let result = s.t.circle.try_contribute(&s.t.alice);

        if behavior.fails() {
            assert!(result.is_err(), "contribute must fail for {behavior:?}");
            assert!(!s.t.circle.has_contributed(&s.t.alice, &0));
            assert_eq!(s.t.circle.get_current_round().contributions_received, 0);
        } else {
            assert!(result.is_ok(), "contribute must succeed for {behavior:?}");
            assert!(s.t.circle.has_contributed(&s.t.alice, &0));
        }

        s.restore_payer(&s.t.alice, state);
        if behavior.fails() {
            s.t.circle.contribute(&s.t.alice);
        }
        assert!(s.t.circle.has_contributed(&s.t.alice, &0));
        assert_eq!(s.t.circle.get_current_round().contributions_received, 1);
    }
}

#[test]
fn payout_transfer_modes_never_leave_partial_state() {
    for behavior in TokenBehavior::ALL {
        let s = TokenScenario::new(behavior);
        s.t.join_all();
        s.t.contribute_all();
        let recipient = s.t.member(0);
        let before = s.t.token.balance(&recipient);
        let state = s.prepare_recipient(&recipient);
        let result = s.t.circle.try_payout();

        if behavior.fails() {
            assert!(result.is_err(), "payout must fail for {behavior:?}");
            assert!(!s.t.circle.get_current_round().paid_out);
            assert_eq!(s.t.token.balance(&recipient), before);
            assert_eq!(s.t.rep.score(&recipient), 0);
        } else {
            assert!(result.is_ok(), "payout must succeed for {behavior:?}");
            assert_eq!(s.t.token.balance(&recipient), before + ROUND_AMOUNT * 4);
            assert_eq!(s.t.rep.score(&recipient), 1);
        }

        s.restore_recipient(&recipient, state);
        if behavior.fails() {
            s.t.circle.payout();
            assert_eq!(s.t.circle.get_current_round().round_index, 1);
        }
    }
}

#[test]
fn settlement_transfer_modes_never_leave_partial_state() {
    for behavior in TokenBehavior::ALL {
        let s = TokenScenario::new(behavior);
        s.t.join_all();
        s.t.circle.contribute(&s.t.alice);
        s.t.advance_past_deadline();
        let recipient = s.t.member(0);
        let before = s.t.token.balance(&recipient);
        let state = s.prepare_recipient(&recipient);
        let result = s.t.circle.try_settle_round();

        if behavior.fails() {
            assert!(result.is_err(), "settle_round must fail for {behavior:?}");
            assert_eq!(s.t.circle.get_current_round().round_index, 0);
            assert!(!s.t.circle.get_current_round().paid_out);
            assert_eq!(s.t.token.balance(&recipient), before);
            for m in [&s.t.bob, &s.t.carol, &s.t.dave] {
                assert_eq!(s.t.circle.get_collateral(m), COLLATERAL);
                assert_eq!(s.t.circle.get_defaults(m), 0);
            }
        } else {
            assert!(result.is_ok(), "settle_round must succeed for {behavior:?}");
            assert_eq!(s.t.circle.get_current_round().round_index, 1);
            assert_eq!(s.t.token.balance(&recipient), before + ROUND_AMOUNT);
        }

        s.restore_recipient(&recipient, state);
        if behavior.fails() {
            s.t.circle.settle_round();
            assert_eq!(s.t.circle.get_current_round().round_index, 1);
        }
    }
}

#[test]
fn collateral_release_transfer_modes_never_leave_partial_state() {
    for behavior in TokenBehavior::ALL {
        let s = TokenScenario::new(behavior);
        s.t.circle.join(&s.t.alice);
        s.t.circle.cancel(&s.t.alice);
        let before = s.t.token.balance(&s.t.alice);
        let state = s.prepare_recipient(&s.t.alice);
        let result = s.t.circle.try_close(&s.t.alice);

        if behavior.fails() {
            assert!(result.is_err(), "close must fail for {behavior:?}");
            assert!(!s.t.circle.is_closed());
            assert_eq!(s.t.circle.get_collateral(&s.t.alice), COLLATERAL);
            assert_eq!(s.t.token.balance(&s.t.alice), before);
        } else {
            assert!(result.is_ok(), "close must succeed for {behavior:?}");
            assert!(s.t.circle.is_closed());
            assert_eq!(s.t.token.balance(&s.t.alice), before + COLLATERAL);
        }

        s.restore_recipient(&s.t.alice, state);
        if behavior.fails() {
            s.t.circle.close(&s.t.alice);
            assert!(s.t.circle.is_closed());
        }
    }
}

#[test]
fn successful_transfers_emit_the_documented_circle_events() {
    let s = TokenScenario::new(TokenBehavior::Success);
    let joined = s.t.circle_events_of(|| s.t.circle.join(&s.t.alice));
    assert!(
        event_names(&s, &joined)
            .iter()
            .any(|n| n.contains("joined")),
        "join must emit circle/joined"
    );

    for m in [&s.t.bob, &s.t.carol, &s.t.dave] {
        s.t.circle.join(m);
    }
    let contributed = s.t.circle_events_of(|| s.t.circle.contribute(&s.t.alice));
    assert!(
        event_names(&s, &contributed)
            .iter()
            .any(|n| n.contains("contributed")),
        "contribute must emit circle/contributed"
    );
}
