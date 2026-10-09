(function (global) {
  var validStates = ["disconnected", "connecting", "connected", "disconnecting", "failed"];

  function transitionConnection(state, event) {
    var transitions = {
      CONNECT: { disconnected: "connecting", failed: "connecting" },
      CONNECTED: { connecting: "connected" },
      CONNECT_FAILED: { connecting: "failed" },
      DISCONNECT: { connected: "disconnecting", failed: "disconnecting" },
      DISCONNECTED: { disconnecting: "disconnected", connected: "disconnected" },
      DISCONNECT_FAILED: { disconnecting: "connected" },
      CORE_EXITED: { connected: "failed" },
      RESTORE_FAILED: { disconnecting: "connected" },
      RESTORED: { connected: "connected" }
    };
    var next = transitions[event] && transitions[event][state];
    return { accepted: Boolean(next), state: next || state };
  }

  function sortServers(servers, favorites) {
    var favoriteIds = new Set(Array.isArray(favorites) ? favorites : []);
    return (Array.isArray(servers) ? servers : [])
      .map(function (server, index) { return { server: server, index: index }; })
      .sort(function (left, right) {
        var favoriteOrder = Number(favoriteIds.has(right.server.id)) - Number(favoriteIds.has(left.server.id));
        return favoriteOrder || left.index - right.index;
      })
      .map(function (item) { return item.server; });
  }

  function toggleFavorite(favorites, serverId) {
    var current = Array.isArray(favorites) ? favorites : [];
    return current.indexOf(serverId) === -1
      ? current.concat([serverId])
      : current.filter(function (id) { return id !== serverId; });
  }

  async function mapWithConcurrency(items, limit, worker) {
    if (!Array.isArray(items) || !Number.isInteger(limit) || limit < 1 || typeof worker !== "function") {
      throw new Error("Invalid bounded-work configuration.");
    }
    var results = new Array(items.length);
    var nextIndex = 0;
    async function runWorker() {
      while (true) {
        var index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }
    var workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    return results;
  }

  function pingResult(error, ping) {
    if (!error && Number.isFinite(ping) && ping >= 0) return { status: "available", ping: ping };
    var timedOut = error && (error.code === "ETIMEDOUT" || /timed out/i.test(error.message || ""));
    return { status: timedOut ? "timeout" : "unavailable", ping: null };
  }

  async function measureServers(servers, ping, onResult, concurrency) {
    return mapWithConcurrency(servers, concurrency || 4, async function (server, index) {
      var result;
      try {
        var measured = await ping(server);
        result = pingResult(null, measured && measured.ping);
      } catch (error) {
        result = pingResult(error, null);
      }
      if (typeof onResult === "function") onResult(server, result, index);
      return { server: server, result: result };
    });
  }

  function bestServer(results) {
    return results.reduce(function (best, item) {
      if (!item || !item.server || !item.result || item.result.status !== "available") return best;
      return !best || item.result.ping < best.result.ping ? item : best;
    }, null);
  }

  async function connectWithOneRetry(connect, delay) {
    var lastError;
    for (var attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await connect(attempt);
      } catch (error) {
        lastError = error;
        if (attempt === 0) await delay(1000);
      }
    }
    throw lastError;
  }

  function startupPlan(settings, savedServerAvailable, hasServers) {
    if (!settings || !settings.autoConnect) return "disabled";
    if (savedServerAvailable) return "saved";
    return settings.autoConnectBestServer && hasServers ? "best" : "unavailable";
  }

  global.ChoobsUIState = {
    validStates: validStates,
    transitionConnection: transitionConnection,
    sortServers: sortServers,
    toggleFavorite: toggleFavorite,
    mapWithConcurrency: mapWithConcurrency,
    measureServers: measureServers,
    bestServer: bestServer,
    connectWithOneRetry: connectWithOneRetry,
    startupPlan: startupPlan
  };
  if (typeof module !== "undefined" && module.exports) module.exports = global.ChoobsUIState;
}(typeof window !== "undefined" ? window : globalThis));
