const assert = require("node:assert/strict");
const { test } = require("node:test");
const UIState = require("../app/js/ui-state");

test("connection state transitions represent idle, pending, success, and failure", () => {
  assert.equal(UIState.transitionConnection("disconnected", "CONNECT").state, "connecting");
  assert.equal(UIState.transitionConnection("connecting", "CONNECTED").state, "connected");
  assert.equal(UIState.transitionConnection("connecting", "CONNECT_FAILED").state, "failed");
  assert.equal(UIState.transitionConnection("failed", "CONNECT").state, "connecting");
  assert.equal(UIState.transitionConnection("connected", "DISCONNECT").state, "disconnecting");
  assert.equal(UIState.transitionConnection("disconnecting", "DISCONNECTED").state, "disconnected");
  assert.equal(UIState.transitionConnection("disconnecting", "DISCONNECT_FAILED").state, "connected");
  assert.equal(UIState.transitionConnection("disconnected", "DISCONNECT").accepted, false);
  assert.equal(UIState.transitionConnection("connecting", "CONNECT").accepted, false);
  assert.equal(UIState.transitionConnection("connecting", "DISCONNECT").accepted, false);
  assert.equal(UIState.transitionConnection("disconnecting", "DISCONNECT").accepted, false);
});

test("favorite sorting is stable and tolerates favorites whose servers disappeared", () => {
  const servers = [{ id: "one" }, { id: "two" }, { id: "three" }];
  assert.deepEqual(
    UIState.sortServers(servers, ["three", "missing"]),
    [servers[2], servers[0], servers[1]]
  );
  const added = UIState.toggleFavorite(["existing"], "new");
  assert.deepEqual(added, ["existing", "new"]);
  assert.deepEqual(UIState.toggleFavorite(added, "existing"), ["new"]);
});

test("latency checks honor concurrency and report timeout and unavailable separately", async () => {
  const servers = Array.from({ length: 9 }, (_, index) => ({ id: String(index) }));
  let active = 0;
  let maximumActive = 0;
  const results = await UIState.measureServers(servers, async (server) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (server.id === "1") throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    if (server.id === "2") throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    return { ping: Number(server.id) + 10 };
  }, null, 3);

  assert.equal(maximumActive, 3);
  assert.equal(results[1].result.status, "timeout");
  assert.equal(results[1].result.ping, null);
  assert.equal(results[2].result.status, "unavailable");
  assert.equal(UIState.bestServer(results).server.id, "0");
});

test("automatic connection retry is bounded to one retry", async () => {
  let attempts = 0;
  let delays = 0;
  const result = await UIState.connectWithOneRetry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
    return "connected";
  }, async (milliseconds) => {
    assert.equal(milliseconds, 1000);
    delays += 1;
  });
  assert.equal(result, "connected");
  assert.equal(attempts, 2);
  assert.equal(delays, 1);

  attempts = 0;
  await assert.rejects(UIState.connectWithOneRetry(async () => {
    attempts += 1;
    throw new Error("persistent failure");
  }, async () => {}), /persistent failure/);
  assert.equal(attempts, 2);
});

test("startup auto-connect requires opt-in and best-server fallback requires its own opt-in", () => {
  assert.equal(UIState.startupPlan({ autoConnect: false, autoConnectBestServer: true }, false, true), "disabled");
  assert.equal(UIState.startupPlan({ autoConnect: true, autoConnectBestServer: false }, true, true), "saved");
  assert.equal(UIState.startupPlan({ autoConnect: true, autoConnectBestServer: false }, false, true), "unavailable");
  assert.equal(UIState.startupPlan({ autoConnect: true, autoConnectBestServer: true }, false, true), "best");
});
