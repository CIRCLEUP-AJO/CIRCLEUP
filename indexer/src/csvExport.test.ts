/**
 * Unit tests for the circle activity CSV export (Issue #696).
 *
 * Pure functions only — no database.  Covers empty, large (bounded),
 * Unicode and adversarial inputs, exact amount formatting, and determinism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CSV_COLUMNS,
  CSV_EXPORT_MAX_ROWS,
  CsvExportTooLargeError,
  buildCircleActivityCsv,
  escapeCsvField,
  exportFilename,
  formatStroops,
  formatUsdc,
  neutralizeFormula,
  resolveNetworkName,
  type CircleActivity,
  type ExportContributionRow,
} from "./csvExport";

const CIRCLE = `C${"A".repeat(55)}`;
const ALICE = `G${"A".repeat(55)}`;
const BOB = `G${"B".repeat(55)}`;
const HEADER = CSV_COLUMNS.join(",");
const BOM = "﻿";

function emptyActivity(overrides: Partial<CircleActivity> = {}): CircleActivity {
  return {
    network: "testnet",
    circleAddress: CIRCLE,
    members: [],
    contributions: [],
    defaults: [],
    payouts: [],
    ...overrides,
  };
}

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF records). */
function parseCsv(text: string): string[][] {
  assert.ok(text.startsWith(BOM), "export must start with a UTF-8 BOM");
  const body = text.slice(BOM.length);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && body[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else {
      field += ch;
    }
  }
  assert.equal(field, "", "document must end with CRLF");
  assert.equal(row.length, 0, "document must end with CRLF");
  return rows;
}

function asObjects(text: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text);
  assert.deepEqual(header, [...CSV_COLUMNS]);
  return rows.map((r) => {
    assert.equal(r.length, CSV_COLUMNS.length, "every row has every column");
    return Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, r[i]]));
  });
}

// ─── Amount formatting ────────────────────────────────────────────────────────

test("formatUsdc: exact 7-decimal formatting with integer arithmetic", () => {
  assert.equal(formatUsdc("0"), "0.0000000");
  assert.equal(formatUsdc("1"), "0.0000001");
  assert.equal(formatUsdc("100000000"), "10.0000000");
  assert.equal(formatUsdc("100000001"), "10.0000001");
  assert.equal(formatUsdc("-25"), "-0.0000025");
  assert.equal(formatUsdc(123n), "0.0000123");
});

test("formatUsdc: preserves precision far beyond Number.MAX_SAFE_INTEGER (i128 range)", () => {
  const i128Max = "170141183460469231731687303715884105727";
  assert.equal(formatStroops(i128Max), i128Max);
  assert.equal(formatUsdc(i128Max), "17014118346046923173168730371588.4105727");
  assert.equal(formatUsdc("9007199254740993"), "900719925.4740993");
});

test("formatStroops: canonicalises leading zeros and rejects non-integers", () => {
  assert.equal(formatStroops("000120"), "120");
  for (const bad of ["1.5", "1e9", "", " ", "NaN", "0x10", "=1+1", "１２"]) {
    assert.throws(() => formatStroops(bad), /not an integer/, `must reject ${JSON.stringify(bad)}`);
  }
});

// ─── Field escaping ──────────────────────────────────────────────────────────

test("neutralizeFormula: prefixes every formula trigger with an apostrophe", () => {
  for (const payload of [
    "=HYPERLINK(\"http://evil\",\"x\")",
    "+1+1",
    "-1+1",
    "@SUM(A1)",
    "\t=1",
    "\r=1",
    "＝1+1",
    "＋1",
    "－1",
    "＠SUM(A1)",
  ]) {
    assert.equal(neutralizeFormula(payload), `'${payload}`);
  }
  assert.equal(neutralizeFormula("plain"), "plain");
  assert.equal(neutralizeFormula("a=b"), "a=b", "only leading triggers matter");
});

test("escapeCsvField: RFC 4180 quoting with doubled quotes", () => {
  assert.equal(escapeCsvField("plain"), "plain");
  assert.equal(escapeCsvField("a,b"), '"a,b"');
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvField("line1\nline2"), '"line1\nline2"');
  assert.equal(escapeCsvField(null), "");
  assert.equal(escapeCsvField(undefined), "");
  assert.equal(escapeCsvField(0), "0");
  assert.equal(escapeCsvField(false), "false");
});

test("escapeCsvField: formula neutralised before quoting so the cell stays inert", () => {
  assert.equal(escapeCsvField('=cmd|" /C calc"!A0,'), `"'=cmd|"" /C calc""!A0,"`);
  assert.equal(escapeCsvField("\r\n=1"), `"'\r\n=1"`);
});

// ─── Document building ───────────────────────────────────────────────────────

test("empty circle: header only, BOM + CRLF", () => {
  const csv = buildCircleActivityCsv(emptyActivity());
  assert.equal(csv, `${BOM}${HEADER}\r\n`);
  assert.deepEqual(asObjects(csv), []);
});

test("rows carry network context, typed columns and exact amounts", () => {
  const csv = buildCircleActivityCsv(
    emptyActivity({
      members: [{ member_address: ALICE, payout_order: 0, join_order: 1, defaults: 0, collateral: "100000000" }],
      contributions: [{ member_address: ALICE, round_index: 0, amount: "100000000", ledger: "10", tx_hash: "aa" }],
      defaults: [{ member_address: BOB, round_index: 0, penalty: "20000000", ledger: "11", tx_hash: "bb" }],
      payouts: [{ recipient: ALICE, round_index: 0, amount: "200000000", is_exceptional: true, ledger: "12", tx_hash: "cc" }],
    }),
  );
  const rows = asObjects(csv);
  assert.deepEqual(rows.map((r) => r.record_type), ["member", "contribution", "default", "payout"]);
  for (const r of rows) {
    assert.equal(r.network, "testnet");
    assert.equal(r.circle_address, CIRCLE);
  }
  assert.equal(rows[0].payout_order, "0");
  assert.equal(rows[0].join_order, "1");
  assert.equal(rows[0].amount_usdc, "10.0000000");
  assert.equal(rows[2].amount_stroops, "20000000");
  assert.equal(rows[2].amount_usdc, "2.0000000");
  assert.equal(rows[3].exceptional, "true");
  assert.equal(rows[1].exceptional, "", "exceptional only applies to payouts");
  assert.equal(rows[3].ledger, "12");
});

test("unjoined member: null join_order exports as an empty cell", () => {
  const rows = asObjects(
    buildCircleActivityCsv(
      emptyActivity({
        members: [{ member_address: ALICE, payout_order: 0, join_order: null, defaults: 0, collateral: "0" }],
      }),
    ),
  );
  assert.equal(rows[0].join_order, "");
  assert.equal(rows[0].amount_usdc, "0.0000000");
});

test("deterministic: input order does not change the output bytes", () => {
  const contributions: ExportContributionRow[] = [
    { member_address: BOB, round_index: 1, amount: "5", ledger: "30", tx_hash: "t3" },
    { member_address: ALICE, round_index: 0, amount: "5", ledger: "20", tx_hash: "t2" },
    { member_address: BOB, round_index: 0, amount: "5", ledger: "20", tx_hash: "t1" },
    { member_address: ALICE, round_index: 1, amount: "5", ledger: "9", tx_hash: "t0" },
  ];
  const a = buildCircleActivityCsv(emptyActivity({ contributions }));
  const b = buildCircleActivityCsv(emptyActivity({ contributions: [...contributions].reverse() }));
  assert.equal(a, b);
  const order = asObjects(a).map((r) => `${r.round_index}:${r.ledger}:${r.member_address === ALICE ? "A" : "B"}`);
  // round ASC, then numeric ledger ASC (9 before 30, not lexicographic), then member.
  assert.deepEqual(order, ["0:20:A", "0:20:B", "1:9:A", "1:30:B"]);
});

test("Unicode values survive intact and the BOM marks the encoding", () => {
  const csv = buildCircleActivityCsv(
    emptyActivity({
      network: "testnet",
      contributions: [
        { member_address: "Ⓖ-ünïcødé-会员-👩🏽‍💻", round_index: 0, amount: "1", ledger: "1", tx_hash: "ハッシュ,\"x\"" },
      ],
    }),
  );
  const [row] = asObjects(csv);
  assert.equal(row.member_address, "Ⓖ-ünïcødé-会员-👩🏽‍💻");
  assert.equal(row.tx_hash, 'ハッシュ,"x"');
});

test("adversarial values: formula payloads, delimiters and line breaks are inert", () => {
  const evil = [
    '=HYPERLINK("http://evil.example","click")',
    "+cmd|' /C calc'!A0",
    "-2+3",
    "@SUM(1+1)*cmd|' /C calc'!A0",
    "\t=1",
    "a\r\nb,c",
    "＝1+1",
  ];
  const csv = buildCircleActivityCsv(
    emptyActivity({
      circleAddress: evil[0],
      network: evil[1],
      payouts: evil.map((v, i) => ({
        recipient: v,
        round_index: i,
        amount: "1",
        is_exceptional: false,
        ledger: String(i),
        tx_hash: v,
      })),
    }),
  );
  const rows = asObjects(csv);
  assert.equal(rows.length, evil.length, "embedded line breaks must not create extra records");
  for (const [i, row] of rows.entries()) {
    for (const value of Object.values(row)) {
      assert.doesNotMatch(value, /^[=+\-@\t\r＝＋－＠]/, `cell ${JSON.stringify(value)} could execute`);
    }
    assert.equal(row.member_address.replace(/^'/, ""), evil[i], "only the apostrophe guard is added");
  }
  assert.equal(rows[0].circle_address, `'${evil[0]}`);
  assert.equal(rows[0].network, `'${evil[1]}`);
  assert.equal(rows[5].tx_hash, "a\r\nb,c", "non-formula text is preserved verbatim");
});

test("adversarial amounts: a non-integer NUMERIC aborts the export instead of exporting garbage", () => {
  assert.throws(
    () =>
      buildCircleActivityCsv(
        emptyActivity({
          contributions: [{ member_address: ALICE, round_index: 0, amount: "1.5", ledger: "1", tx_hash: "t" }],
        }),
      ),
    /not an integer/,
  );
});

test("large: exactly CSV_EXPORT_MAX_ROWS rows is allowed", () => {
  const contributions: ExportContributionRow[] = Array.from({ length: CSV_EXPORT_MAX_ROWS }, (_, i) => ({
    member_address: ALICE,
    round_index: i,
    amount: "100000000",
    ledger: String(i + 1),
    tx_hash: `t${i}`,
  }));
  const csv = buildCircleActivityCsv(emptyActivity({ contributions }));
  const lines = csv.slice(BOM.length).split("\r\n");
  assert.equal(lines.length, CSV_EXPORT_MAX_ROWS + 2, "header + rows + trailing empty");
});

test("large: one row over the cap is refused, not truncated", () => {
  const members = Array.from({ length: 2 }, (_, i) => ({
    member_address: `G${String(i).padStart(55, "A")}`,
    payout_order: i,
    join_order: i + 1,
    defaults: 0,
    collateral: "1",
  }));
  assert.throws(
    () => buildCircleActivityCsv(emptyActivity({ members }), 1),
    (err: unknown) => err instanceof CsvExportTooLargeError && err.rowCount === 2 && err.maxRows === 1,
  );
});

// ─── Network / filename ──────────────────────────────────────────────────────

test("resolveNetworkName derives the network from the RPC URL", () => {
  assert.equal(resolveNetworkName("https://soroban-testnet.stellar.org"), "testnet");
  assert.equal(resolveNetworkName("https://rpc-futurenet.stellar.org"), "futurenet");
  assert.equal(resolveNetworkName("https://mainnet.sorobanrpc.com"), "mainnet");
  assert.equal(resolveNetworkName("http://localhost:8000/soroban/rpc"), "local");
  assert.equal(resolveNetworkName("https://rpc.example.com"), "unknown");
  assert.equal(resolveNetworkName(undefined), "unknown");
  assert.equal(resolveNetworkName("not a url"), "unknown");
});

test("exportFilename is stable for a circle", () => {
  assert.equal(exportFilename(CIRCLE), `circle-${CIRCLE}-activity.csv`);
});
