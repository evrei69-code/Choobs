const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createVlessDiagnostic } = require("../app/js/vless-diagnostics");

const uuid = "123e4567-e89b-12d3-a456-426614174000";

function server(uri) {
  return { protocol: "VLESS", address: "private-server.example", port: 443, uri };
}

test("diagnoses the supported VLESS TCP baseline without exposing server identity", () => {
  const report = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?encryption=none&security=tls&type=tcp`
  ));

  assert.match(report, /Type: tcp — SUPPORTED/);
  assert.match(report, /TCP: SUPPORTED/);
  assert.match(report, /Server: \[MASKED\]/);
  assert.match(report, /UUID: \[MASKED\]/);
  assert.equal(report.includes(uuid), false);
  assert.equal(report.includes("private-server.example"), false);
});

test("reports Reality and Vision as partial support while masking keys and SNI", () => {
  const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const report = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?security=reality&pbk=${key}&sid=ab12&sni=front.example&fp=chrome&flow=xtls-rprx-vision`
  ));

  assert.match(report, /Reality: PARTIAL/);
  assert.match(report, /Vision: PARTIAL/);
  assert.match(report, /fp: chrome — FOUND; RECOGNIZED; SUPPORTED/);
  assert.match(report, /sni: \[MASKED\]/);
  assert.equal(report.includes(key), false);
  assert.equal(report.includes("ab12"), false);
  assert.equal(report.includes("front.example"), false);
});

test("flags XHTTP and mode as unsupported while retaining the safe mode value", () => {
  const report = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?mode=stream-up&type=xhttp&security=reality`
  ));

  assert.match(report, /XHTTP: NOT SUPPORTED/);
  assert.match(report, /Mode: stream-up — NOT SUPPORTED BY CURRENT RUNTIME/);
  assert.match(report, /mode: stream-up — FOUND; NOT RECOGNIZED; NOT SUPPORTED/);
  assert.match(report, /- mode/);
  assert.match(report, /- type/);
});

test("flags WebSocket and gRPC transports as unsupported", () => {
  const ws = createVlessDiagnostic(server(`vless://${uuid}@private-server.example:443?type=ws`));
  const grpc = createVlessDiagnostic(server(`vless://${uuid}@private-server.example:443?type=grpc`));
  assert.match(ws, /WebSocket: NOT SUPPORTED/);
  assert.match(grpc, /gRPC: NOT SUPPORTED/);
});

test("reports empty ALPN values as unsupported by the current config generator", () => {
  const report = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?security=tls&alpn=`
  ));
  assert.match(report, /alpn: \[EMPTY\] — FOUND; RECOGNIZED; NOT SUPPORTED/);
  assert.match(report, /- alpn/);
});

test("decodes percent-encoded names and values and preserves repeated query values", () => {
  const report = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?%74ype=xhttp&mode=packet%2Dup&alpn=h2&alpn=http%2F1.1&security=reality&security=tls`
  ));

  assert.match(report, /Mode: packet-up/);
  assert.match(report, /type: xhttp — FOUND; RECOGNIZED; NOT SUPPORTED/);
  assert.match(report, /alpn: h2, http\/1\.1/);
  assert.match(report, /security: reality, tls — FOUND; RECOGNIZED; NOT SUPPORTED/);
  assert.match(report, /parameter "security" is repeated/i);
});

test("treats unknown-case parameter names and conflicting aliases as unsupported", () => {
  const report = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?security=tls&sni=front-one.example&serverName=front-two.example&TYPE=tcp&customOption=synthetic-secret`
  ));

  assert.match(report, /\[REDACTED_PARAMETER\]: \[MASKED\] — FOUND; NOT RECOGNIZED; NOT SUPPORTED/);
  assert.equal(report.includes("TYPE"), false);
  assert.match(report, /sni: \[MASKED\] — FOUND; RECOGNIZED; NOT SUPPORTED/);
  assert.match(report, /Conflicting aliases "sni" and "serverName"/);
  assert.equal(report.includes("synthetic-secret"), false);
});

test("marks missing parameters explicitly and records malformed URIs without throwing", () => {
  const missing = createVlessDiagnostic(server(`vless://${uuid}@private-server.example`));
  assert.match(missing, /mode: \[NOT FOUND\]/);
  assert.match(missing, /serviceName: \[NOT FOUND\]/);
  assert.match(missing, /Type: tcp \(default\) — SUPPORTED/);

  const invalid = createVlessDiagnostic(server("vless://["));
  assert.match(invalid, /URI could not be parsed/);
  assert.match(invalid, /Server: \[MASKED\]/);
  assert.equal(invalid.includes("%ZZ"), false);
});

test("never includes an arbitrary URI scheme in the generated report", () => {
  const uri = `synthetic-token://${uuid}@private-server.example:443?security=tls`;
  const report = createVlessDiagnostic(server(uri));
  const validReport = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?security=tls`
  ));

  assert.match(report, /Protocol: Unknown/);
  assert.equal(report.includes("synthetic-token"), false);
  assert.match(validReport, /Protocol: VLESS/);
});

test("masks UUID, password, keys, short IDs, tokens, hostnames, SNI, and secret paths", () => {
  const password = "synthetic-password";
  const publicKey = "synthetic-public-key";
  const privateKey = "synthetic-private-key";
  const token = "synthetic-access-token";
  const report = createVlessDiagnostic(server(
    `vless://${uuid}:${password}@private-server.example:443?security=reality&pbk=${publicKey}&privateKey=${privateKey}&sid=deadbeef&sni=secret-front.example&mode=packet-up&type=xhttp&path=%2Fapi%3Ftoken%3D${token}&customCredential=${token}`
  ));

  for (const secret of [
    uuid, password, publicKey, privateKey, "deadbeef",
    "private-server.example", "secret-front.example", token
  ]) {
    assert.equal(report.includes(secret), false, `report exposed ${secret}`);
  }
  assert.match(report, /Password user-info: \[MASKED\]/);
  assert.match(report, /path: \[PRESENT; VALUE MASKED\]/);
  assert.equal(report.includes("customCredential"), false);
  assert.match(report, /\[REDACTED_PARAMETER\]: \[MASKED\]/);
});

test("never exports path content containing nested secrets", () => {
  const paths = [
    { path: "/connect?sid=shortsecret", secrets: ["shortsecret"] },
    { path: "/connect?auth=authsecret", secrets: ["authsecret"] },
    { path: "/connect?sig=signaturesecret", secrets: ["signaturesecret"] },
    { path: "/connect?token=tokensecret", secrets: ["tokensecret"] },
    { path: "/connect/segmentsecret", secrets: ["segmentsecret"] },
    {
      path: "/connect?token=percent%73ecret",
      secrets: ["percent%73ecret", "percentsecret"]
    },
    {
      path: "/connect?sid=firstsecret&sid=secondsecret&auth=thirdsecret&auth=fourthsecret",
      secrets: ["firstsecret", "secondsecret", "thirdsecret", "fourthsecret"]
    }
  ];

  for (const { path, secrets } of paths) {
    const encodedPath = encodeURIComponent(path);
    const report = createVlessDiagnostic(server(
      `vless://${uuid}@private-server.example:443?path=${encodedPath}`
    ));

    assert.match(report, /path: \[PRESENT; VALUE MASKED\]/);
    assert.equal(report.includes(path), false, "report included the path");
    assert.equal(report.includes(encodedPath), false, "report included the encoded path");
    for (const secret of secrets) {
      assert.equal(report.includes(secret), false, `report exposed ${secret}`);
    }
  }
});

test("masks double-encoded path secrets and URI fragments in the generated report", () => {
  const secret = "double-encoded-secret-marker";
  const encodedSecret = encodeURIComponent(encodeURIComponent(secret));
  const path = `/connect?token=${encodedSecret}`;
  const encodedPath = encodeURIComponent(path);
  const fragment = "synthetic-fragment-secret";
  const report = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?path=${encodedPath}#${fragment}`
  ));

  assert.match(report, /path: \[PRESENT; VALUE MASKED\]/);
  for (const value of [
    secret,
    encodeURIComponent(secret),
    encodedSecret,
    path,
    encodedPath,
    fragment
  ]) {
    assert.equal(report.includes(value), false, `report exposed ${value}`);
  }
});

test("masks values for sensitive parameter-name variants and repeated parameters", () => {
  const parameters = [
    ["token", "synthetic-token-secret"],
    ["Token", "synthetic-Token-secret"],
    ["access_token", "synthetic-access-token-secret"],
    ["auth", "synthetic-auth-secret"],
    ["sig", "synthetic-signature-secret"],
    ["key", "synthetic-key-secret"],
    ["secret", "synthetic-secret-value"],
    ["sid", "synthetic-short-id-secret"],
    ["token", "synthetic-repeated-token-secret"]
  ];
  const query = parameters
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  const report = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?${query}`
  ));

  for (const [, value] of parameters) {
    assert.equal(report.includes(value), false, `report exposed ${value}`);
  }
  for (const name of ["token", "Token", "access_token", "auth", "sig", "key", "secret"]) {
    assert.equal(report.includes(`${name}:`), false, `report exposed parameter name ${name}`);
  }
  assert.ok(report.includes("sid: [MASKED]"));
  assert.ok(report.includes("[REDACTED_PARAMETER]: [MASKED]"));
});

test("redacts unknown parameter names in regular, repeated, and URL-encoded query fields", () => {
  const cases = [
    {
      name: "synthetic-parameter-name-secret",
      query: "synthetic-parameter-name-secret=synthetic-value"
    },
    {
      name: "synthetic-repeated-name-secret",
      query: "synthetic-repeated-name-secret=first&synthetic-repeated-name-secret=second",
      repeated: true
    },
    {
      name: "synthetic-encoded-name-secret",
      query: "%73ynthetic%2Dencoded%2Dname%2Dsecret=synthetic-value"
    }
  ];

  for (const { name, query, repeated } of cases) {
    const report = createVlessDiagnostic(server(
      `vless://${uuid}@private-server.example:443?${query}`
    ));

    assert.equal(report.includes(name), false, `report exposed parameter name ${name}`);
    assert.ok(report.includes("[REDACTED_PARAMETER]"));
    if (repeated) {
      assert.match(report, /Query parameter "\[REDACTED_PARAMETER\]" is repeated/);
    }
  }
});

test("masks values outside the safe transport metadata allowlists", () => {
  const values = [
    "mode=modecredential",
    "type=unknowntransportsecret",
    "flow=unknownflowsecret",
    "security=unknownsecuritysecret",
    "fp=unknownfingerprintsecret",
    "alpn=unknownalpnsecret",
    "headerType=unknownheadersecret",
    "encryption=unknownencryptionsecret"
  ];
  const report = createVlessDiagnostic(server(
    `vless://${uuid}@private-server.example:443?${values.join("&")}`
  ));

  for (const value of values.map((item) => item.slice(item.indexOf("=") + 1))) {
    assert.equal(report.includes(value), false, `report exposed ${value}`);
  }
  for (const name of ["mode", "type", "flow", "security", "fp", "alpn", "headerType", "encryption"]) {
    assert.ok(report.includes(`${name}: [MASKED]`), `report did not mask ${name}`);
  }
});

test("rejects diagnostics for non-VLESS servers", () => {
  assert.throws(
    () => createVlessDiagnostic({ protocol: "VMess", uri: "vmess://private" }),
    /only available for VLESS/
  );
});
