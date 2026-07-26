import { pool } from "./pool";

/**
 * Runs EXPLAIN ANALYZE against the API's frequent query shapes so the
 * indexes added alongside this file can be re-verified after schema changes.
 * Picks a real circle/member address from the connected DB so the plans
 * reflect actual data volume instead of an always-empty placeholder.
 * Run directly: npm run explain --workspace=indexer
 */

function buildQueries(circleAddress: string, memberAddress: string) {
  return [
    {
      label: "GET /circles (list, ordered by created_ledger)",
      sql: `SELECT address, creator, round_amount, member_count, status,
                   current_round, total_rounds, created_ledger, updated_at
            FROM circles ORDER BY created_ledger DESC`,
      params: [] as unknown[],
    },
    {
      label: "GET /circles/:address/members",
      sql: `SELECT cm.*, r.score as reputation_score
            FROM circle_members cm
            LEFT JOIN reputation r ON r.member_address = cm.member_address
            WHERE cm.circle_address = $1
            ORDER BY cm.payout_order`,
      params: [circleAddress],
    },
    {
      label: "GET /circles/:address/rounds — contributions",
      sql: `SELECT * FROM contributions WHERE circle_address = $1 ORDER BY round_index, created_at`,
      params: [circleAddress],
    },
    {
      label: "GET /circles/:address/rounds — defaults",
      sql: `SELECT * FROM defaults WHERE circle_address = $1 ORDER BY round_index`,
      params: [circleAddress],
    },
    {
      label: "GET /circles/:address/rounds — payouts",
      sql: `SELECT * FROM payouts WHERE circle_address = $1 ORDER BY round_index`,
      params: [circleAddress],
    },
    {
      label: "GET /reputation/:member — contributions",
      sql: `SELECT c.circle_address, COUNT(*) as contributions, ci.total_rounds
            FROM contributions c
            JOIN circles ci ON ci.address = c.circle_address
            WHERE c.member_address = $1
            GROUP BY c.circle_address, ci.total_rounds`,
      params: [memberAddress],
    },
    {
      label: "GET /members/:member/contributions",
      sql: `SELECT c.circle_address, c.member_address, c.round_index, c.amount::text as amount,
                   c.tx_hash, c.ledger, c.created_at
            FROM contributions c
            WHERE c.member_address = $1
            ORDER BY c.ledger DESC, c.round_index DESC, c.created_at DESC
            LIMIT $2 OFFSET $3`,
      params: [memberAddress, 20, 0],
    },
    {
      label: "GET /reputation/:member — defaults",
      sql: `SELECT circle_address, COUNT(*) as count
            FROM defaults WHERE member_address = $1 GROUP BY circle_address`,
      params: [memberAddress],
    },
  ];
}

// Picks the circle/member with the most rows so the sample query is
// representative rather than hitting an empty result set.
async function pickSampleAddresses(): Promise<{
  circleAddress: string;
  memberAddress: string;
}> {
  const { rows: circleRows } = await pool.query<{ address: string }>(
    `SELECT address FROM circles ORDER BY created_ledger DESC LIMIT 1`,
  );
  const { rows: memberRows } = await pool.query<{ member_address: string }>(
    `SELECT member_address FROM circle_members LIMIT 1`,
  );

  return {
    circleAddress: circleRows[0]?.address ?? "GNO_CIRCLES_IN_DB",
    memberAddress: memberRows[0]?.member_address ?? "GNO_MEMBERS_IN_DB",
  };
}

async function main() {
  const { circleAddress, memberAddress } = await pickSampleAddresses();
  console.log(
    `[explain] Using sample circle=${circleAddress} member=${memberAddress}`,
  );

  for (const { label, sql, params } of buildQueries(circleAddress, memberAddress)) {
    const { rows } = await pool.query(
      `EXPLAIN (ANALYZE, FORMAT TEXT) ${sql}`,
      params,
    );
    console.log(`\n=== ${label} ===`);
    console.log(rows.map((r) => r["QUERY PLAN"]).join("\n"));
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[explain] Error:", err);
    process.exit(1);
  });
}
