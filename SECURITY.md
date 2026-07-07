# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Active |

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you discover a vulnerability — especially one affecting contract funds, collateral logic, or payout order — please report it privately.

### How to Report

**Option 1 — GitHub Security Advisory (preferred)**
Open a private advisory at:
`https://github.com/CIRCLEUP-AJO/CIRCLEUP/security/advisories/new`

**Option 2 — Email**
Send a report with the subject `[SECURITY] CircleUp Vulnerability` to the maintainers.

### What to Include

- Clear description of the vulnerability
- Steps to reproduce or a proof-of-concept
- Affected component (`circle`, `circle_factory`, `reputation`, `indexer`, `app`)
- Potential impact (e.g. funds at risk, collateral bypass, payout manipulation, unauthorized default)
- Suggested fix if you have one

---

## Response Timeline

| Action | Target |
|--------|--------|
| Acknowledgement | Within 48 hours |
| Severity assessment | Within 5 business days |
| Fix or mitigation shipped | Depends on severity (critical: ASAP) |
| Public disclosure | After fix is deployed and users are notified |

---

## Smart Contract Risk Surface

The core attack surface is in `contracts/circle`:

| Area | Protection |
|------|-----------|
| **Payout** | Only triggers when `contributions_received == member_count`; recipient set at init, immutable |
| **Collateral** | Locked at `join`; only released via `close` after `Completed` or `Cancelled` status |
| **Default penalty** | Capped at 20% per missed round (2000 BPS); cannot exceed current collateral balance |
| **Contribution auth** | `member.require_auth()` — only the member themselves can contribute for their slot |
| **Idempotency** | Temporary storage key prevents double-contribution in the same round |
| **Round advancement** | Only happens inside `payout` after full contribution; no manual override |

---

## Scope

**In scope:**
- `contracts/` — all three Soroban contracts
- `sdk/` — TypeScript SDK
- `indexer/` — event indexer and REST API
- `app/` — Next.js frontend (XSS, wallet spoofing, etc.)

**Out of scope:**
- Third-party dependencies — report to their maintainers
- Issues requiring physical access to a user's device
- Social engineering attacks on users
- Stellar network-level issues — report to the [Stellar Security Team](https://www.stellar.org/bug-bounty-program)

---

## Disclosure Policy

We follow **coordinated disclosure**. We ask that you give us reasonable time to patch before any public disclosure. Researchers who report valid vulnerabilities will be credited in the release notes unless they prefer to remain anonymous.
