import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const contractSources = {
  circle: readFileSync(new URL("../../../contracts/circle/src/lib.rs", import.meta.url), "utf8"),
  factory: readFileSync(new URL("../../../contracts/circle_factory/src/lib.rs", import.meta.url), "utf8"),
  reputation: readFileSync(new URL("../../../contracts/reputation/src/lib.rs", import.meta.url), "utf8"),
};

function declarationBody(source: string, kind: "enum" | "struct", name: string): string {
  const match = source.match(new RegExp(`pub ${kind} ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Missing Rust ${kind} ${name}`);
  return match[1];
}

function declarations(source: string, kind: "enum" | "struct", name: string): string[] {
  return declarationBody(source, kind, name)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const match = kind === "struct"
        ? line.match(/^pub (\w+): (.+?),?$/)
        : line.match(/^([A-Z]\w*(?:\([^)]*\))?)(?:\s*=\s*\d+)?,?$/);
      if (!match) throw new Error(`Unrecognized ${kind} declaration in ${name}: ${line}`);
      return match[1];
    });
}

function errorCodes(source: string, name: string): string[] {
  return declarationBody(source, "enum", name)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([A-Z]\w*)\s*=\s*(\d+),?$/);
      if (!match) throw new Error(`Unrecognized error discriminant in ${name}: ${line}`);
      return `${match[1]}=${match[2]}`;
    });
}

describe("contract storage and error compatibility (Issue #693)", () => {
  it("pins persisted keys and value field order/types", () => {
    expect(declarations(contractSources.circle, "enum", "DataKey")).toEqual([
      "Config", "Status", "CurrentRound", "Collateral(Address)",
      "Contributed(Address, u32)", "Defaults(Address)", "Defaulted(Address, u32)",
      "RoundsCompleted", "Initializing", "Closed", "UsdcToken", "Admin", "Paused",
    ]);
    expect(declarations(contractSources.factory, "enum", "DataKey")).toEqual([
      "Admin", "CircleWasmHash", "ReputationContract", "UsdcToken", "Circles",
      "CircleCount", "Initializing",
    ]);
    expect(declarations(contractSources.reputation, "enum", "DataKey")).toEqual([
      "Score(Address)", "Admin", "AuthorizedCallers", "RevokedCallers", "Initializing",
    ]);
    expect(declarations(contractSources.circle, "struct", "CircleConfig")).toEqual([
      "members", "round_amount", "usdc_token", "reputation_contract", "round_deadline_ledgers",
    ]);
    expect(declarations(contractSources.circle, "struct", "RoundState")).toEqual([
      "round_index", "recipient", "contributions_received", "deadline_ledger", "paid_out",
    ]);
    expect(declarations(contractSources.circle, "enum", "CircleStatus")).toEqual([
      "Pending", "Active", "Completed", "Cancelled",
    ]);
  });

  it("pins all existing contract error discriminants", () => {
    expect(errorCodes(contractSources.circle, "InitError")).toEqual([
      "AlreadyInitialized=1", "TooFewMembers=2", "TooManyMembers=3",
      "DuplicateMembers=4", "InvalidRoundAmount=5", "RoundAmountPotOverflow=6",
      "RoundAmountPenaltyOverflow=7", "DeadlineBelowMinimum=8", "DeadlineAboveMaximum=9",
      "InvalidTokenAddress=10", "InvalidReputationAddress=11", "InconsistentRotation=12",
      "UnusableTokenContract=13", "InitializeInProgress=14",
    ]);
    expect(errorCodes(contractSources.circle, "PauseError")).toEqual([
      "Unauthorized=1", "AlreadyPaused=2", "NotPaused=3", "NotInitialized=4",
    ]);
    expect(errorCodes(contractSources.circle, "CloseError")).toEqual([
      "AlreadyClosed=1", "NotTerminalState=2", "Unauthorized=3", "RoundsIncomplete=4",
    ]);
    expect(errorCodes(contractSources.circle, "ContractError")).toEqual([
      "NotInitialized=1", "CircleNotActive=2", "PotOverflow=3", "NotMember=4",
      "DuplicateAction=5", "WrongStatus=6", "CirclePaused=7", "DeadlinePassed=8",
      "DeadlineNotPassed=9", "AlreadyPaidOut=10", "IncompleteRound=11",
      "MemberNotJoined=12", "AlreadyDefaulted=13", "MemberContributed=14",
    ]);
    expect(errorCodes(contractSources.factory, "FactoryError")).toEqual([
      "TooFewMembers=100", "TooManyMembers=101", "DuplicateMembers=102",
      "InvalidRoundAmount=103", "PotOverflow=104", "PenaltyOverflow=105",
      "DeadlineBelowMinimum=106", "DeadlineAboveMaximum=107",
      "AlreadyInitialized=108", "InitializeInProgress=109",
    ]);
    expect(errorCodes(contractSources.reputation, "ReputationError")).toEqual([
      "UnauthorizedCaller=1", "NotAdmin=2", "CallerNotFound=3", "NotInitialized=4",
      "CallerRevoked=5", "ScoreOverflow=6", "AlreadyInitialized=7",
      "InitializeInProgress=8",
    ]);
  });
});