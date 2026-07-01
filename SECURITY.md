# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes    |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a vulnerability in CircleUp — especially one affecting the smart contracts, collateral handling, or payout logic — please report it privately.

**How to report:**

1. Open a **private** GitHub Security Advisory at:
   `https://github.com/Hovibby/CIRCLUP/security/advisories/new`

2. Or email the maintainers directly with the subject line `[SECURITY] CircleUp Vulnerability`.

**Include in your report:**
- A clear description of the vulnerability
- Steps to reproduce or a proof-of-concept
- The potential impact (e.g. funds at risk, collateral bypass, payout manipulation)
- Any suggested fix if you have one

## Response Timeline

| Action | Timeframe |
|--------|-----------|
| Acknowledgement | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix or mitigation | Depends on severity |
| Public disclosure | After fix is deployed |

## Smart Contract Security

CircleUp's core risk surface is the `circle` contract. Key areas:

- **Payout logic** — only triggers when all members have contributed; recipient is set at initialization and cannot be changed
- **Collateral** — locked at join, only released via `close` after completion or cancellation
- **Default penalty** — capped at 20% per missed round; cannot exceed collateral balance
- **Access control** — `join` and `contribute` require the caller's own auth; `payout` and `mark_default` are permissionless but have strict on-chain guards

## Scope

In scope:
- `contracts/` — all three Soroban contracts
- `sdk/` — TypeScript SDK
- `indexer/` — event indexer and REST API
- `app/` — Next.js frontend

Out of scope:
- Third-party dependencies (report to their maintainers)
- Issues requiring physical access to a user's device
- Social engineering attacks

## Disclosure Policy

We follow **coordinated disclosure**. We ask that you give us reasonable time to patch before making any public disclosure. We will credit researchers who report valid vulnerabilities in our release notes unless they prefer to remain anonymous.
