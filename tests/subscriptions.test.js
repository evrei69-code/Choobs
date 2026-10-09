const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../app/js/subscriptions.js");

test("VLESS subscription parsing preserves URI and extracts server details", () => {
  const uri = "vless://123e4567-e89b-12d3-a456-426614174000@node.example:8443?encryption=none&security=tls&type=tcp&sni=edge.example&alpn=h2%2Chttp%2F1.1&fp=chrome#Germany%20Frankfurt";
  const result = globalThis.SubscriptionManager.parse(uri, "test-subscription");

  assert.equal(result.skipped, 0);
  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].protocol, "VLESS");
  assert.equal(result.servers[0].address, "node.example");
  assert.equal(result.servers[0].port, 8443);
  assert.equal(result.servers[0].source, "test-subscription");
  assert.equal(result.servers[0].name, "Germany Frankfurt");
  assert.equal(result.servers[0].uri, uri);
});

test("VLESS parser decodes a percent-encoded feed but preserves URI encoding", () => {
  const uri = "vless://123e4567-e89b-12d3-a456-426614174000@node.example:8443?security=tls&sni=edge.example&alpn=h2%2Chttp%2F1.1#Germany%20Frankfurt";
  const result = globalThis.SubscriptionManager.parse(encodeURIComponent(uri), "encoded-subscription");

  assert.equal(result.skipped, 0);
  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].uri, uri);
  assert.equal(result.servers[0].name, "Germany Frankfurt");
});

test("VLESS parser preserves percent-encoded Reality parameters for the config generator", () => {
  const uri = "vless://11111111-2222-4333-8444-555555555555@node.example:443?encryption=none&security=reality&type=tcp&headerType=none&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D&sid=%61bcd&sni=front%2Eexample&fp=chrome&flow=xtls-rprx-vision";
  const result = globalThis.SubscriptionManager.parse(uri, "reality-subscription");

  assert.equal(result.skipped, 0);
  assert.equal(result.servers.length, 1);
  assert.equal(result.servers[0].protocol, "VLESS");
  assert.equal(result.servers[0].address, "node.example");
  assert.equal(result.servers[0].uri, uri);
  assert.equal(new URL(result.servers[0].uri).searchParams.get("pbk"), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  assert.equal(new URL(result.servers[0].uri).searchParams.get("sid"), "abcd");
  assert.equal(new URL(result.servers[0].uri).searchParams.get("sni"), "front.example");
});

test("subscription parser decodes CRLF-wrapped unpadded URL-safe Base64 Reality feeds", () => {
  const realityParams = "security=reality&type=tcp&headerType=none&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D&sid=abcd&sni=front.example&fp=chrome&flow=xtls-rprx-vision";
  const entries = Array.from({ length: 23 }, (_, index) => {
    const id = String(index + 1).padStart(12, "0");
    return `vless://${id}-2222-4333-8444-555555555555@node${index + 1}.example:443?${realityParams}#Test%F0%9F%98%80-${index + 1}`;
  });
  entries.push(
    "hysteria2://unsupported-one.example:443",
    "hysteria2://unsupported-two.example:443",
    "hysteria2://unsupported-three.example:443"
  );
  const decodedText = `\uFEFF${entries.join("\r\n")}`;
  const base64 = Buffer.from(decodedText, "utf8").toString("base64");
  const urlSafeUnpadded = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.match(urlSafeUnpadded, /[-_]/);
  const wrapped = `\uFEFF${urlSafeUnpadded.match(/.{1,73}/g).join("\r\n")}`;

  const result = globalThis.SubscriptionManager.parse({
    text: wrapped,
    diagnostics: {
      httpStatus: 200,
      contentType: "text/plain",
      responseBytes: wrapped.length,
      decodedBytes: wrapped.length
    }
  }, "base64-reality-subscription");

  assert.equal(result.servers.length, 23);
  assert.equal(result.skipped, 3);
  assert.equal(result.diagnostics.httpStatus, 200);
  assert.equal(result.diagnostics.contentType, "text/plain");
  assert.equal(result.diagnostics.format, "base64 URI list");
  assert.equal(result.diagnostics.lineCount, 26);
  assert.equal(result.diagnostics.uriLikeLines, 26);
  assert.equal(result.diagnostics.protocols.VLESS, 23);
  assert.equal(result.diagnostics.protocols["Other/unsupported"], 3);
  assert.equal(result.diagnostics.uriLines.length, 26);
  assert.equal(result.diagnostics.uriLines[0].scheme, "vless");
  assert.equal(result.diagnostics.uriLines[0].startsWithExpectedScheme, true);
  assert.deepEqual(result.diagnostics.uriLines[0].queryParameterNames, [
    "security", "type", "headerType", "pbk", "sid", "sni", "fp", "flow"
  ]);
  assert.equal(JSON.stringify(result.diagnostics).includes("AAAAAAAA"), false);
  assert.equal(JSON.stringify(result.diagnostics).includes("front.example"), false);
  assert.equal(result.diagnostics.uriLines[23].scheme, "hysteria2");
  assert.equal(result.diagnostics.uriLines[23].reason, "unsupported scheme");
  assert.equal(result.servers[0].protocol, "VLESS");
  const query = new URL(result.servers[0].uri).searchParams;
  assert.equal(query.get("pbk"), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
  assert.equal(query.get("sid"), "abcd");
  assert.equal(query.get("sni"), "front.example");
  assert.equal(query.get("fp"), "chrome");
  assert.equal(query.get("flow"), "xtls-rprx-vision");
  assert.equal(query.get("headerType"), "none");
});

test("subscription parser normalizes per-line BOM and CR-only separators", () => {
  const feed = [
    "\uFEFFVLESS://11111111-2222-4333-8444-555555555555@upper.example:443?security=reality&pbk=synthetic-key&sid=synthetic-id&sni=edge.example&fp=chrome&flow=xtls-rprx-vision&type=tcp&headerType=none",
    "\uFEFFvless://11111111-2222-4333-8444-555555555555@lower.example:443?security=tls"
  ].join("\r");

  const result = globalThis.SubscriptionManager.parse(feed, "normalized-subscription");

  assert.equal(result.servers.length, 2);
  assert.equal(result.diagnostics.protocols.VLESS, 2);
  assert.equal(result.servers[0].address, "upper.example");
  assert.equal(result.servers[1].address, "lower.example");
  assert.equal(result.diagnostics.lineCount, 2);
});

test("safe per-line diagnostics identify scheme and rejection reason without URI values", () => {
  const credential = "synthetic-secret-credential";
  const publicKey = "synthetic-secret-key";
  const feed = [
    `vless://${credential}@node.example:443?security=reality&pbk=${publicKey}&sid=private-value&sni=edge.example&fp=chrome&flow=vision&type=tcp&headerType=none`,
    "hysteria2://unsupported.example:443?token=private-value",
    "not-a-uri"
  ].join("\n");

  const diagnostics = globalThis.SubscriptionManager.diagnose(feed);

  assert.equal(diagnostics.length, 3);
  assert.deepEqual(diagnostics[0], {
    scheme: "vless",
    length: feed.split("\n")[0].length,
    validUri: true,
    queryParameterNames: ["security", "pbk", "sid", "sni", "fp", "flow", "type", "headerType"],
    startsWithExpectedScheme: true,
    hostnameLength: "node.example".length,
    invisibleCharactersPresent: false,
    reason: "parsed"
  });
  assert.equal(diagnostics[1].scheme, "hysteria2");
  assert.equal(diagnostics[1].validUri, true);
  assert.equal(diagnostics[1].startsWithExpectedScheme, false);
  assert.equal(diagnostics[1].reason, "unsupported scheme");
  assert.equal(diagnostics[2].reason, "missing URI scheme");
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(credential), false);
  assert.equal(serialized.includes(publicKey), false);
  assert.equal(serialized.includes("private-value"), false);
  assert.equal(serialized.includes("edge.example"), false);
});

test("VLESS authority fallback imports servers when the platform URL parser rejects custom schemes", () => {
  const originalUrl = globalThis.URL;
  globalThis.URL = function (value, base) {
    if (typeof value === "string" && /^vless:\/\//i.test(value)) {
      throw new TypeError("synthetic platform URL rejection");
    }
    return new originalUrl(value, base);
  };
  try {
    const result = globalThis.SubscriptionManager.parse(
      "vless://11111111-2222-4333-8444-555555555555@compat.example:443?security=reality&pbk=synthetic-key&sid=synthetic-id&sni=edge.example&fp=chrome&flow=vision&type=tcp&headerType=none",
      "compatibility-subscription"
    );

    assert.equal(result.servers.length, 1);
    assert.equal(result.servers[0].address, "compat.example");
    assert.equal(result.servers[0].port, 443);
    assert.equal(result.diagnostics.protocols.VLESS, 1);
    assert.equal(result.diagnostics.uriLines[0].reason, "parsed");
  } finally {
    globalThis.URL = originalUrl;
  }
});

test("subscription parser reports invisible URI characters and does not double-decode Base64", () => {
  const ordinaryUri = "vless://11111111-2222-4333-8444-555555555555@node.example:443?security=tls";
  const invisibleUri = ordinaryUri.replace("vless://", "vless\u200B://");
  const twiceEncoded = Buffer.from(Buffer.from(ordinaryUri, "utf8").toString("base64"), "utf8").toString("base64");

  const invisibleDiagnostics = globalThis.SubscriptionManager.diagnose(invisibleUri);
  const invisibleResult = globalThis.SubscriptionManager.parse(invisibleUri, "invisible-subscription");
  const doubleEncodedResult = globalThis.SubscriptionManager.parse(twiceEncoded, "double-encoded-subscription");

  assert.equal(invisibleResult.servers.length, 0);
  assert.equal(invisibleDiagnostics[0].scheme, "unrecognized");
  assert.equal(invisibleDiagnostics[0].invisibleCharactersPresent, true);
  assert.match(invisibleDiagnostics[0].reason, /invisible character/);
  assert.equal(doubleEncodedResult.servers.length, 0);
  assert.equal(doubleEncodedResult.diagnostics.format, "unrecognized");
});

test("subscription diagnostics for unrecognized responses contain no body content", () => {
  const responseText = "not-a-subscription-secret-response";
  const result = globalThis.SubscriptionManager.parse({
    text: responseText,
    diagnostics: { httpStatus: 200, contentType: "text/plain", responseBytes: responseText.length }
  }, "invalid-subscription");
  assert.equal(result.servers.length, 0);
  assert.equal(result.diagnostics.format, "unrecognized");
  assert.equal(result.diagnostics.lineCount, 1);
  assert.equal(JSON.stringify(result.diagnostics).includes(responseText), false);
});

test("subscription add reports safe fetch and parser diagnostics when nothing is recognized", async () => {
  const responseText = "body-must-not-appear-in-diagnostics";
  const previousStorage = globalThis.ChoobsStorage;
  globalThis.ChoobsStorage = {
    fetchSubscription: async () => ({
      text: responseText,
      diagnostics: { httpStatus: 200, contentType: "text/plain", responseBytes: responseText.length }
    })
  };
  try {
    await assert.rejects(
      globalThis.SubscriptionManager.add({
        servers: [],
        subscriptions: [],
        selectedServerId: null,
        settings: {}
      }, "Safe test", "https://subscriptions.example/safe-test"),
      (error) => {
        assert.match(error.message, /HTTP 200, text\/plain/);
        assert.match(error.message, /unrecognized, 1 lines, 0 URI-like/);
        assert.equal(error.message.includes(responseText), false);
        return true;
      }
    );
  } finally {
    globalThis.ChoobsStorage = previousStorage;
  }
});

test("subscription parser handles padded Base64 URI lists with mixed supported and unknown protocols", () => {
  const vmessPayload = Buffer.from(JSON.stringify({
    v: "2",
    ps: "Safe VMess",
    add: "vmess.example",
    port: "443",
    id: "11111111-2222-4333-8444-555555555555"
  }), "utf8").toString("base64");
  const entries = [
    "vless://11111111-2222-4333-8444-555555555555@vless.example:443?security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=abcd&sni=front.example&fp=chrome&flow=xtls-rprx-vision&headerType=none",
    `vmess://${vmessPayload}`,
    "trojan://synthetic-password@trojan.example:443",
    "ss://aes-128-gcm:synthetic-password@ss.example:8388",
    "socks5://socks.example:1080",
    "https://https.example:443/path",
    "hysteria2://unsupported.example:443"
  ];
  const encoded = Buffer.from(entries.join("\n"), "utf8").toString("base64");
  const result = globalThis.SubscriptionManager.parse(encoded, "mixed-subscription");

  assert.equal(result.servers.length, 6);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.diagnostics.protocols, {
    VLESS: 1,
    VMess: 1,
    Trojan: 1,
    Shadowsocks: 1,
    SOCKS5: 1,
    HTTPS: 1,
    "Other/unsupported": 1
  });
});

test("subscription parser safely rejects malformed Base64 and handles empty content", () => {
  const malformed = globalThis.SubscriptionManager.parse("abcde===", "malformed-subscription");
  assert.equal(malformed.servers.length, 0);
  assert.equal(malformed.diagnostics.format, "unrecognized");

  const empty = globalThis.SubscriptionManager.parse("\uFEFF \r\n\t", "empty-subscription");
  assert.equal(empty.servers.length, 0);
  assert.equal(empty.skipped, 0);
  assert.equal(empty.diagnostics.format, "empty");
  assert.equal(empty.diagnostics.lineCount, 0);
});

test("subscription refresh replaces servers only after a valid non-empty parse and keeps favorites", async () => {
  const uri = "vless://11111111-2222-4333-8444-555555555555@node.example:443?security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=abcd&sni=front.example&fp=chrome&flow=xtls-rprx-vision#Finland%20Helsinki";
  const server = {
    id: "stable-server-id",
    name: "Finland Helsinki",
    location: "Helsinki",
    flag: "🇫🇮",
    address: "node.example",
    port: 443,
    protocol: "VLESS",
    source: "subscription-one",
    ping: 42,
    uri
  };
  const originalFetch = globalThis.ChoobsStorage;
  const config = {
    servers: [server],
    subscriptions: [{
      id: "subscription-one",
      name: "Primary",
      url: "https://subscriptions.example/safe",
      updatedAt: "2026-01-01T00:00:00.000Z",
      servers: [server]
    }],
    favorites: ["stable-server-id", "orphaned-server-id"],
    selectedServerId: "stable-server-id",
    settings: { rememberSelectedServer: true }
  };
  try {
    globalThis.ChoobsStorage = { fetchSubscription: async () => ({ text: uri }) };
    const refreshed = await globalThis.SubscriptionManager.refresh(config, "subscription-one");
    assert.deepEqual(refreshed.config.favorites, config.favorites);
    assert.equal(refreshed.config.servers[0].id, "stable-server-id");
    assert.equal(refreshed.config.servers[0].ping, 42);
    assert.equal(refreshed.config.selectedServerId, "stable-server-id");
    assert.notEqual(refreshed.config.subscriptions[0].updatedAt, config.subscriptions[0].updatedAt);

    globalThis.ChoobsStorage = { fetchSubscription: async () => { throw new Error("synthetic fetch failure"); } };
    await assert.rejects(globalThis.SubscriptionManager.refresh(config, "subscription-one"), /synthetic fetch failure/);
    assert.equal(config.servers[0].id, "stable-server-id");
    assert.equal(config.subscriptions[0].servers[0].uri, uri);

    globalThis.ChoobsStorage = { fetchSubscription: async () => ({ text: "\uFEFF \r\n" }) };
    await assert.rejects(
      globalThis.SubscriptionManager.refresh(config, "subscription-one"),
      /No supported VPN servers were found/
    );
    assert.equal(config.servers.length, 1);
    assert.deepEqual(config.favorites, ["stable-server-id", "orphaned-server-id"]);
  } finally {
    globalThis.ChoobsStorage = originalFetch;
  }
});

test("subscription name is optional and secret URL components are hidden", async () => {
  const previousStorage = globalThis.ChoobsStorage;
  globalThis.ChoobsStorage = {
    fetchSubscription: async () => ({
      text: "vless://11111111-2222-4333-8444-555555555555@node.example:443?security=tls",
      diagnostics: { httpStatus: 200, contentType: "text/plain", responseBytes: 75 }
    })
  };
  try {
    const added = await globalThis.SubscriptionManager.add({
      servers: [],
      subscriptions: [],
      selectedServerId: null,
      settings: {}
    }, "", "https://subscriptions.example/private-path?token=synthetic-secret");
    assert.equal(added.config.subscriptions[0].name, "My subscription");
    assert.equal(globalThis.SubscriptionManager.displayUrl("https://subscriptions.example/private-path?token=synthetic-secret"), "subscriptions.example");
    assert.equal(globalThis.SubscriptionManager.displayUrl("not-a-url?token=synthetic-secret"), "Subscription URL");
  } finally {
    globalThis.ChoobsStorage = previousStorage;
  }
});
