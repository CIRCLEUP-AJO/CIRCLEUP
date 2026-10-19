import { createServer } from "node:http";

const port = Number(process.env.VISUAL_FIXTURE_PORT ?? 3101);
const activeCircle = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
const pendingCircle = "CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW";
const members = [
  "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
  "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U",
];

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function circlePayload(status) {
  return {
    circle: {
      address: status === "Active" ? activeCircle : pendingCircle,
      creator: members[0],
      round_amount: "250000000",
      member_count: members.length,
      status,
      current_round: 0,
      total_rounds: members.length,
      created_ledger: 1000,
      updated_at: "2026-01-01T00:00:00.000Z",
      deadline_ledger: status === "Active" ? 5000 : null,
    },
    members: members.map((member_address, payout_order) => ({
      member_address,
      payout_order,
      collateral: "250000000",
      defaults: 0,
      joined_at: "2026-01-01T00:00:00.000Z",
      reputation_score: 3,
      total_contributions: 0,
    })),
    latestLedger: 4000,
  };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const path = decodeURIComponent(url.pathname);

  if (path === "/health") {
    response.writeHead(200);
    response.end("ok");
    return;
  }

  if (path === "/circles") {
    send(response, 200, {
      circles: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    return;
  }

  if (path === `/circles/${activeCircle}` || path === `/circles/${pendingCircle}`) {
    send(response, 200, circlePayload(path.endsWith(activeCircle) ? "Active" : "Pending"));
    return;
  }

  if (path === `/circles/${activeCircle}/rounds` || path === `/circles/${pendingCircle}/rounds`) {
    const active = path.includes(activeCircle);
    send(response, 200, {
      rounds: [],
      openRounds: [],
      pendingDefaults: [],
      currentRound: active
        ? { roundIndex: 0, status: "current", recipient: null, amount: null, txHash: null, contributions: [], defaults: [] }
        : null,
    });
    return;
  }

  if (path.startsWith("/reputation/")) {
    send(response, 503, { error: "fixture indexer unavailable" });
    return;
  }

  send(response, 404, { error: "fixture not found" });
});

server.listen(port, "127.0.0.1");