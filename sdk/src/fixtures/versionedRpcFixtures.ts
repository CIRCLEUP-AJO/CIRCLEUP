/**
 * Versioned, sanitized Soroban RPC response fixtures for Protocol 21 and Protocol 22+.
 *
 * Sanitization guarantees:
 * - All contract IDs and account addresses use standard deterministic test strkeys.
 * - All transaction hashes use deterministic hex strings ("0000...0001").
 * - No user identifiers, secrets, or private keys.
 * - Byte sequences and XDR payloads are deterministic and valid.
 *
 * Versioning:
 * - Protocol 21 (v21): Standard Soroban RPC initial release format.
 * - Protocol 22 (v22+): Modern Soroban RPC format with enhanced diagnostic metadata,
 *   multi-result arrays, and extended ledger properties.
 */

export const SANITIZED_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
export const SANITIZED_ACCOUNT_ID = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
export const SANITIZED_TX_HASH = "0000000000000000000000000000000000000000000000000000000000000001";

// ─── Protocol 21 Fixtures ─────────────────────────────────────────────────────

export const V21_RPC_FIXTURES = {
  version: "21.0.0",
  protocolVersion: 21,

  getEvents: {
    success: {
      latestLedger: 10500,
      events: [
        {
          id: "000000004509715456-0000000001",
          type: "contract",
          ledger: 10500,
          ledgerClosedAt: "2026-01-01T12:00:00Z",
          contractId: SANITIZED_CONTRACT_ID,
          topic: ["AAAABQAAAAdmYWN0b3J5AAAA", "AAAABQAAAA5jaXJjbGVfY3JlYXRlZAAAAA=="],
          value: {
            circleAddress: SANITIZED_CONTRACT_ID,
            creator: SANITIZED_ACCOUNT_ID,
            circleIndex: 0,
          },
          pagingToken: "000000004509715456-0000000001",
          inSuccessfulContractCall: true,
        },
      ],
      cursor: "000000004509715456-0000000001",
    },
    empty: {
      latestLedger: 10500,
      events: [],
    },
    error: {
      code: -32600,
      message: "Invalid startLedger: 10501 is greater than latest ledger 10500",
    },
    additiveFields: {
      latestLedger: 10500,
      events: [
        {
          id: "000000004509715456-0000000001",
          type: "contract",
          ledger: 10500,
          ledgerClosedAt: "2026-01-01T12:00:00Z",
          contractId: SANITIZED_CONTRACT_ID,
          topic: ["AAAABQAAAAdmYWN0b3J5AAAA"],
          value: { ok: true },
          // Unknown additive fields from future RPC versions:
          sorobanRpcVersion: "21.3.0",
          diagnosticEvents: [],
          feeCharged: "100",
        },
      ],
      sorobanRpcVersion: "21.3.0",
      queryDurationMs: 4.2,
    },
  },

  simulateTransaction: {
    success: {
      id: "sim-v21-001",
      latestLedger: 10500,
      minResourceFee: "150000",
      cost: {
        cpuInsns: "1250000",
        memBytes: "524288",
      },
      results: [
        {
          auth: [],
          xdr: "AAAAEAAAAAEAAAACAAAAAQ==",
        },
      ],
      events: [],
      transactionData: "AAAAAAAAAAIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
    withRestorePreamble: {
      id: "sim-v21-002",
      latestLedger: 10500,
      minResourceFee: "200000",
      restorePreamble: {
        minResourceFee: "85000",
        transactionData: "AAAAAwAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      cost: { cpuInsns: "500000", memBytes: "102400" },
      events: [],
    },
    failure: {
      id: "sim-v21-err",
      latestLedger: 10500,
      events: [],
      error: "HostError: Error(Contract, #1) Circle has reached maximum member capacity",
    },
  },

  sendTransaction: {
    pending: {
      status: "PENDING",
      hash: SANITIZED_TX_HASH,
      latestLedger: 10500,
      latestLedgerCloseTime: 1767272400,
    },
    duplicate: {
      status: "DUPLICATE",
      hash: SANITIZED_TX_HASH,
      latestLedger: 10500,
    },
    tryAgainLater: {
      status: "TRY_AGAIN_LATER",
      hash: SANITIZED_TX_HASH,
    },
    error: {
      status: "ERROR",
      hash: SANITIZED_TX_HASH,
      errorResult: "txFAILED",
    },
  },

  getTransaction: {
    success: {
      status: "SUCCESS",
      latestLedger: 10505,
      latestLedgerCloseTime: 1767272425,
      oldestLedger: 10000,
      ledger: 10501,
      createdAt: 1767272405,
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: "AAAAAgAAAA...",
      resultXdr: "AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=",
      resultMetaXdr: "AAAAAQAAAA...",
    },
    notFound: {
      status: "NOT_FOUND",
      latestLedger: 10505,
      latestLedgerCloseTime: 1767272425,
    },
    failed: {
      status: "FAILED",
      latestLedger: 10505,
      ledger: 10502,
      resultXdr: "AAAAAAAAAGT/////AAAAAQ==",
    },
  },

  getLatestLedger: {
    success: {
      id: "0000000000002904000000000000000000000000000000000000000000000000",
      protocolVersion: 21,
      sequence: 10500,
      ledgerCloseTime: 1767272400,
    },
  },
};

// ─── Protocol 22+ Fixtures ────────────────────────────────────────────────────

export const V22_RPC_FIXTURES = {
  version: "22.0.0",
  protocolVersion: 22,

  getEvents: {
    success: {
      latestLedger: 25000,
      events: [
        {
          id: "000000010737418240-0000000002",
          type: "contract",
          ledger: 25000,
          ledgerClosedAt: "2026-06-01T12:00:00.000Z",
          contractId: SANITIZED_CONTRACT_ID,
          topic: ["AAAABQAAAAdjaXJjbGUAAAA=", "AAAABQAAAA1jb250cmlidXRlZAAA"],
          value: {
            member: SANITIZED_ACCOUNT_ID,
            round: 2,
            amount: "100000000",
          },
          pagingToken: "000000010737418240-0000000002",
          inSuccessfulContractCall: true,
          // v22+ extended fields:
          txHash: SANITIZED_TX_HASH,
        },
      ],
      cursor: "000000010737418240-0000000002",
      // v22+ additive envelope metadata:
      oldestLedger: 20000,
      cursorFilter: null,
    },
    empty: {
      latestLedger: 25000,
      events: [],
      oldestLedger: 20000,
    },
    additiveFields: {
      latestLedger: 25000,
      events: [
        {
          id: "000000010737418240-0000000002",
          type: "contract",
          ledger: 25000,
          ledgerClosedAt: "2026-06-01T12:00:00.000Z",
          contractId: SANITIZED_CONTRACT_ID,
          topic: ["AAAABQAAAAdjaXJjbGUAAAA="],
          value: { round: 2 },
          // Unknown additive fields from v23:
          eventIndex: 2,
          authContext: "invoker",
        },
      ],
      unrestoredPagingToken: null,
      serverVersion: "22.2.0-rc1",
    },
  },

  simulateTransaction: {
    success: {
      id: "sim-v22-001",
      latestLedger: 25000,
      minResourceFee: "175000",
      cost: {
        cpuInsns: "1850000",
        memBytes: "655360",
      },
      results: [
        {
          auth: [],
          xdr: "AAAAEAAAAAEAAAACAAAAAQ==",
        },
      ],
      events: [],
      transactionData: "AAAAAAAAAAIAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      // v22+ additive fields
      diagnosticEvents: [],
      stateChanges: [],
    },
    failure: {
      id: "sim-v22-err",
      latestLedger: 25000,
      events: [],
      error: "HostError: Error(Auth, #3) Caller is not the registered circle member",
      diagnosticEvents: [
        {
          event: "auth_failed",
          details: "missing signature for invocation",
        },
      ],
    },
  },

  sendTransaction: {
    pending: {
      status: "PENDING",
      hash: SANITIZED_TX_HASH,
      latestLedger: 25000,
      latestLedgerCloseTime: 1780315200,
      // v22+ additive fields:
      network: "testnet",
      clientTimestamp: 1780315201,
    },
    error: {
      status: "ERROR",
      hash: SANITIZED_TX_HASH,
      errorResult: "txBAD_AUTH",
      diagnosticEvents: [],
    },
  },

  getTransaction: {
    success: {
      status: "SUCCESS",
      latestLedger: 25010,
      latestLedgerCloseTime: 1780315250,
      oldestLedger: 20000,
      ledger: 25001,
      createdAt: 1780315205,
      applicationOrder: 2,
      feeBump: false,
      envelopeXdr: "AAAAAgAAAA...",
      resultXdr: "AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAA=",
      resultMetaXdr: "AAAAAQAAAA...",
      diagnosticEventsXdr: ["AAAAAQAAAA..."],
      // v22+ additive fields
      feeCharged: "100",
      unrestoredPagingToken: null,
    },
    notFound: {
      status: "NOT_FOUND",
      latestLedger: 25010,
      latestLedgerCloseTime: 1780315250,
      oldestLedger: 20000,
    },
  },

  getLatestLedger: {
    success: {
      id: "00000000000061A8000000000000000000000000000000000000000000000000",
      protocolVersion: 22,
      sequence: 25000,
      ledgerCloseTime: 1780315200,
      headerXdr: "AAAAAgAAAAYAAAAA...",
    },
  },
};
