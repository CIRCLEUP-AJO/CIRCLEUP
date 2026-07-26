import {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
  Contract,
  SorobanRpc,
} from "@stellar/stellar-sdk";
import type {
  CircleUpConfig,
  CircleConfig,
  RoundState,
  CircleStatus,
  MemberState,
  TxResult,
} from "./types";
import { validateCircleUpConfig, isValidContractAddress } from "./types";

const MAX_RETRIES = 3;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

// ─── Base client ─────────────────────────────────────────────────────────────

export class CircleUpClient {
  protected rpc: SorobanRpc.Server;
  protected config: CircleUpConfig;

  constructor(config: CircleUpConfig) {
    // Validate upfront so callers get a clear message for misconfiguration
    // rather than an obscure RPC error on the first method call.
    validateCircleUpConfig(config);
    this.config = config;
    this.rpc = new SorobanRpc.Server(config.rpcUrl, { allowHttp: true });
  }

  // ── Tx helpers ──────────────────────────────────────────────────────────────

  protected async buildAndSend(
    sourceKeypair: Keypair,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<TxResult> {
    const account = await this.rpc.getAccount(sourceKeypair.publicKey());
    const contract = new Contract(contractId);

    const txBuilder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30);

    let tx = txBuilder.build();

    // Simulate first to get footprint + fee
    const simResult = await this.rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      return { txHash: "", success: false, error: simResult.error };
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(sourceKeypair);

    const sendResult = await this.rpc.sendTransaction(preparedTx);
    if (sendResult.status === "ERROR") {
      return {
        txHash: sendResult.hash,
        success: false,
        error: JSON.stringify(sendResult.errorResult),
      };
    }

    // Poll for confirmation
    const hash = sendResult.hash;
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const status = await this.rpc.getTransaction(hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return { txHash: hash, success: true, ledger: status.ledger };
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        return { txHash: hash, success: false, error: "transaction failed" };
      }
    }
    return { txHash: hash, success: false, error: "timeout waiting for confirmation" };
  }

  protected async simulateAndRead<T>(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
  ): Promise<T> {
    const dummyKeypair = Keypair.random();
    // Use a funded testnet account for read-only simulation
    // In production use a fixed funded source
    const account = await this.rpc
      .getAccount(dummyKeypair.publicKey())
      .catch(() => {
        // Create a fake account for simulation
        return {
          id: dummyKeypair.publicKey(),
          sequence: "0",
          incrementSequenceNumber: () => {},
        } as any;
      });

    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simResult = await this.rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(simResult.error);
    }
    if (!("result" in simResult) || !simResult.result) {
      throw new Error("no result from simulation");
    }
    return scValToNative(simResult.result.retval) as T;
  }
}

// ─── Factory client ───────────────────────────────────────────────────────────

export class FactoryClient extends CircleUpClient {
  private get contractId() {
    return this.config.contracts.circleFactory;
  }

  /** Create a new circle. Returns the new circle's contract address. */
  async createCircle(params: {
    creator: Keypair;
    members: string[];
    roundAmountStroops: bigint;
    roundDeadlineLedgers: number;
  }): Promise<{ result: TxResult; circleAddress?: string }> {
    const membersVal = xdr.ScVal.scvVec(
      params.members.map((m) =>
        new Address(m).toScVal()
      ),
    );

    const result = await this.buildAndSend(
      params.creator,
      this.contractId,
      "create_circle",
      [
        new Address(params.creator.publicKey()).toScVal(),
        membersVal,
        nativeToScVal(params.roundAmountStroops, { type: "i128" }),
        nativeToScVal(params.roundDeadlineLedgers, { type: "u32" }),
      ],
    );

    return { result };
  }

  async getCircles(): Promise<string[]> {
    return this.simulateAndRead<string[]>(
      this.contractId,
      "get_circles",
      [],
    );
  }

  async getCircleCount(): Promise<number> {
    return this.simulateAndRead<number>(
      this.contractId,
      "get_circle_count",
      [],
    );
  }
}

// ─── Circle client ────────────────────────────────────────────────────────────

export class CircleClient extends CircleUpClient {
  private circleAddress: string;

  constructor(config: CircleUpConfig, circleAddress: string) {
    super(config);
    if (!circleAddress || typeof circleAddress !== "string") {
      throw new Error("CircleClient: circleAddress is required.");
    }
    if (!isValidContractAddress(circleAddress)) {
      throw new Error(
        `CircleClient: "${circleAddress}" is not a valid Soroban contract address ` +
          `(expected a 56-character string starting with "C").`,
      );
    }
    this.circleAddress = circleAddress;
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  async join(member: Keypair): Promise<TxResult> {
    return this.buildAndSend(
      member,
      this.circleAddress,
      "join",
      [new Address(member.publicKey()).toScVal()],
    );
  }

  async contribute(member: Keypair): Promise<TxResult> {
    return this.buildAndSend(
      member,
      this.circleAddress,
      "contribute",
      [new Address(member.publicKey()).toScVal()],
    );
  }

  async payout(caller: Keypair): Promise<TxResult> {
    return this.buildAndSend(caller, this.circleAddress, "payout", []);
  }

  async markDefault(caller: Keypair, member: string): Promise<TxResult> {
    return this.buildAndSend(
      caller,
      this.circleAddress,
      "mark_default",
      [new Address(member).toScVal()],
    );
  }

  async close(caller: Keypair): Promise<TxResult> {
    return this.buildAndSend(caller, this.circleAddress, "close", []);
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  async getConfig(): Promise<CircleConfig> {
    const raw = await this.simulateAndRead<any>(
      this.circleAddress,
      "get_config",
      [],
    );
    return {
      members: raw.members,
      roundAmount: BigInt(raw.round_amount),
      usdcToken: raw.usdc_token,
      reputationContract: raw.reputation_contract,
      roundDeadlineLedgers: Number(raw.round_deadline_ledgers),
    };
  }

  async getStatus(): Promise<CircleStatus> {
    return this.simulateAndRead<CircleStatus>(
      this.circleAddress,
      "get_status",
      [],
    );
  }

  async getCurrentRound(): Promise<RoundState> {
    const raw = await this.simulateAndRead<any>(
      this.circleAddress,
      "get_current_round",
      [],
    );
    return {
      roundIndex: Number(raw.round_index),
      recipient: raw.recipient,
      contributionsReceived: Number(raw.contributions_received),
      deadlineLedger: BigInt(raw.deadline_ledger),
      paidOut: Boolean(raw.paid_out),
    };
  }

  async getCollateral(member: string): Promise<bigint> {
    return this.simulateAndRead<bigint>(
      this.circleAddress,
      "get_collateral",
      [new Address(member).toScVal()],
    );
  }

  async getDefaults(member: string): Promise<number> {
    return this.simulateAndRead<number>(
      this.circleAddress,
      "get_defaults",
      [new Address(member).toScVal()],
    );
  }

  async hasContributed(member: string, roundIndex: number): Promise<boolean> {
    return this.simulateAndRead<boolean>(
      this.circleAddress,
      "has_contributed",
      [
        new Address(member).toScVal(),
        nativeToScVal(roundIndex, { type: "u32" }),
      ],
    );
  }

  /** Fetch the full state of a circle in one shot */
  async getFullState(): Promise<{
    config: CircleConfig;
    status: CircleStatus;
    currentRound: RoundState;
  }> {
    const [config, status, currentRound] = await Promise.all([
      this.getConfig(),
      this.getStatus(),
      this.getCurrentRound(),
    ]);
    return { config, status, currentRound };
  }
}

// ─── Reputation client ────────────────────────────────────────────────────────

export class ReputationClient extends CircleUpClient {
  private get contractId() {
    return this.config.contracts.reputation;
  }

  async getScore(member: string): Promise<number> {
    return this.simulateAndRead<number>(
      this.contractId,
      "score",
      [new Address(member).toScVal()],
    );
  }
}
