const net = require("node:net");

const FORMAT_VERSION = "1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINTS = new Set([
  "chrome", "firefox", "edge", "safari", "360", "qq", "ios", "android", "random", "randomized"
]);
const SECRET_NAME = /(?:pass(?:word)?|token|secret|credential|auth|private.?key|public.?key|(?:^|[_-])key(?:$|[_-])|uuid|short.?id|(?:^|[_-])sid(?:$|[_-])|pbk)/i;
const PARAMETER_NAMES = [
  "encryption", "security", "type", "flow", "mode", "headerType", "host", "path", "serviceName",
  "spiderX", "sni", "serverName", "fp", "alpn", "pbk", "publicKey", "sid", "shortId"
];
const SAFE_PARAMETER_NAMES = new Set(PARAMETER_NAMES);
const SUPPORTED_PARAMETERS = new Set([
  "encryption", "security", "type", "flow", "headerType", "host", "path", "serviceName",
  "spiderX", "sni", "serverName", "fp", "alpn", "pbk", "publicKey", "sid", "shortId"
]);
const SAFE_VALUES = new Map([
  ["encryption", new Set(["none"])],
  ["security", new Set(["none", "tls", "reality"])],
  ["type", new Set(["tcp", "xhttp", "ws", "grpc", "httpupgrade", "http", "kcp", "quic", "domainsocket", "splithttp", "h2"])],
  ["flow", new Set(["xtls-rprx-vision"])],
  ["mode", new Set(["auto", "packet-up", "stream-up", "stream-one"])],
  ["fp", FINGERPRINTS],
  ["alpn", new Set(["h2", "http/1.1", "h3", "h3-29", "h3-32", "spdy/3.1", "http/1.0", "h2c"])],
  ["headerType", new Set(["none"])]
]);

function clean(value, maxLength = 256) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeParameterName(value) {
  return SAFE_PARAMETER_NAMES.has(value) ? value : "[REDACTED_PARAMETER]";
}

function displayValue(name, value) {
  const lowerName = name.toLowerCase();
  if (lowerName === "path") return "[PRESENT; VALUE MASKED]";
  if (SECRET_NAME.test(name) || ["host", "sni", "servername"].includes(lowerName)) return "[MASKED]";
  if (!value) return "[EMPTY]";

  const allowedValues = SAFE_VALUES.get(name);
  if (!allowedValues) return "[MASKED]";
  const values = name === "alpn" ? value.split(",").map((item) => item.trim()) : [value];
  if (!values.every((item) => allowedValues.has(item))) return "[MASKED]";
  return clean(values.join(name === "alpn" ? ", " : ""));
}

function parseUri(uri) {
  const warnings = [];
  const raw = typeof uri === "string" ? uri.trim() : "";
  const malformedEncoding = /%(?![0-9a-f]{2})/i.test(raw);
  if (malformedEncoding) warnings.push("Malformed percent-encoding detected; affected values may not be parsed correctly.");

  let parsed = null;
  try {
    if (!raw || raw.length > 8192) throw new Error("invalid URI length");
    parsed = new URL(raw);
  } catch (_error) {
    warnings.push("URI could not be parsed.");
  }

  if (parsed && parsed.protocol.toLowerCase() !== "vless:") {
    warnings.push("URI scheme is not VLESS.");
  }
  const query = parsed ? Array.from(parsed.searchParams.entries()) : [];
  const counts = new Map();
  query.forEach(([name]) => counts.set(name, (counts.get(name) || 0) + 1));
  counts.forEach((count, name) => {
    if (count > 1 && name !== "alpn") {
      warnings.push(`Query parameter "${safeParameterName(name)}" is repeated; the current runtime rejects repeated values for this parameter.`);
    }
  });
  if (parsed && parsed.password) warnings.push("URI contains password user-info; credentials are not included in this report.");

  const username = parsed ? decodeUserInfo(parsed.username) : "";
  if (!username) warnings.push("VLESS user ID is missing.");
  else if (!UUID_PATTERN.test(username)) warnings.push("VLESS user ID is not a valid UUID.");
  if (parsed && !parsed.hostname) warnings.push("Server address is missing.");

  return { parsed, query, counts, warnings };
}

function decodeUserInfo(value) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return "";
  }
}

function valuesFor(query, names) {
  const requested = new Set(names);
  return query.filter(([name]) => requested.has(name)).map(([, value]) => value);
}

function firstValue(query, names) {
  return valuesFor(query, names)[0] || "";
}

function isSupportedParameter(name, values, security, query) {
  const key = name;
  const repeated = values.length > 1;
  if (!SUPPORTED_PARAMETERS.has(key)) return false;
  if (repeated && key !== "alpn") return false;
  switch (key) {
    case "encryption":
      return values.every((item) => !item || item === "none");
    case "security":
      return values.every((item) => !item || ["none", "tls", "reality"].includes(item));
    case "type":
      return values.every((item) => !item || item === "tcp");
    case "flow":
      return values.every((item) => !item || (
        item === "xtls-rprx-vision" && security === "reality" && hasValidRealityKey(query)
      ));
    case "headerType":
      return values.every((item) => !item || item === "none");
    case "host":
    case "path":
    case "serviceName":
    case "spiderX":
      return values.every((item) => !item);
    case "sni":
      return values.every((item) => !item || (
        (security === "tls" || security === "reality") && validHost(item)
      )) &&
        !hasConflictingAliases(name, values, query);
    case "serverName":
      return values.every((item) => !item || (
        (security === "tls" || security === "reality") && validHost(item)
      )) &&
        !hasConflictingAliases(name, values, query);
    case "fp":
      return values.every((item) => !item || (["tls", "reality"].includes(security) && FINGERPRINTS.has(item)));
    case "alpn":
      return values.every((item) => Boolean(item) && (
        ["tls", "reality"].includes(security) &&
        item.split(",").every((protocol) => protocol.trim() !== "")
      ));
    case "pbk":
      return values.every((item) => !item || (
        security === "reality" && validRealityPublicKey(item)
      )) && !hasConflictingAliases(name, values, query);
    case "publicKey":
      return values.every((item) => !item || (
        security === "reality" && validRealityPublicKey(item)
      )) && !hasConflictingAliases(name, values, query);
    case "sid":
      return values.every((item) => !item || (
        security === "reality" && item.length <= 16 && item.length % 2 === 0 && /^[0-9a-f]*$/i.test(item)
      )) && !hasConflictingAliases(name, values, query);
    case "shortId":
      return values.every((item) => !item || (
        security === "reality" && item.length <= 16 && item.length % 2 === 0 && /^[0-9a-f]*$/i.test(item)
      )) && !hasConflictingAliases(name, values, query);
    default:
      return false;
  }
}

function hasConflictingAliases(name, values, query) {
  if (!values.length) return false;
  const aliases = {
    sni: "serverName",
    serverName: "sni",
    pbk: "publicKey",
    publicKey: "pbk",
    sid: "shortId",
    shortId: "sid"
  };
  const alias = aliases[name];
  if (!alias) return false;
  return values.some((value) => valuesFor(query, [alias]).some((aliasValue) => value && aliasValue && value !== aliasValue));
}

function validRealityPublicKey(value) {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
  const unpadded = value.replace(/=+$/, "");
  const decoded = Buffer.from(unpadded, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === unpadded;
}

function hasValidRealityKey(query) {
  const values = valuesFor(query, ["pbk", "publicKey"]);
  if (!values.length) return false;
  if (firstValue(query, ["pbk"]) && firstValue(query, ["publicKey"]) &&
      firstValue(query, ["pbk"]) !== firstValue(query, ["publicKey"])) return false;
  return values.some(validRealityPublicKey);
}

function validHost(value) {
  if (net.isIP(value)) return true;
  if (!value || value.length > 253 || value.endsWith(".")) return false;
  return value.split(".").every((label) => (
    label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-") &&
    /^[A-Za-z0-9-]+$/.test(label)
  ));
}

function parameterStatus(name, values, query, security) {
  const recognized = SUPPORTED_PARAMETERS.has(name);
  const supported = recognized && isSupportedParameter(name, values, security, query);
  if (!recognized) return "FOUND; NOT RECOGNIZED; NOT SUPPORTED";
  if (!supported) return "FOUND; RECOGNIZED; NOT SUPPORTED";
  return "FOUND; RECOGNIZED; SUPPORTED";
}

function createVlessDiagnostic(server, options = {}) {
  if (!server || typeof server !== "object" || server.protocol !== "VLESS") {
    throw new Error("VLESS diagnostics are only available for VLESS servers.");
  }

  const { parsed, query, counts, warnings } = parseUri(server.uri);
  const securityValues = valuesFor(query, ["security"]);
  const typeValues = valuesFor(query, ["type"]);
  const flowValues = valuesFor(query, ["flow"]);
  const modeValues = valuesFor(query, ["mode"]);
  const security = securityValues[0] || "";
  const network = typeValues.length ? typeValues[0] || "[EMPTY]" : "tcp (default)";
  const flow = flowValues[0] || "";
  const mode = modeValues[0] || "";
  const uriPort = parsed && parsed.port ? Number(parsed.port) : null;
  const serverPort = Number.isInteger(server.port) && server.port >= 1 && server.port <= 65535
    ? server.port
    : null;
  const port = uriPort || serverPort;
  const uuid = parsed ? decodeUserInfo(parsed.username) : "";
  const effectiveSecurity = security || "none";
  const parameterLines = [];
  const emitted = new Set();
  const unsupported = new Set();

  PARAMETER_NAMES.forEach((name) => {
    const values = valuesFor(query, [name]);
    if (!values.length) {
      const recognized = SUPPORTED_PARAMETERS.has(name);
      const supported = recognized && isSupportedParameter(name, [], effectiveSecurity, query);
      const status = recognized
        ? `NOT FOUND; RECOGNIZED; ${supported ? "SUPPORTED BY DEFAULT" : "NOT APPLICABLE"}`
        : "NOT FOUND; NOT RECOGNIZED; NOT SUPPORTED";
      parameterLines.push(`${name}: [NOT FOUND] — ${status}`);
      return;
    }
    emitted.add(name);
    const shown = values.map((value) => displayValue(name, value)).join(", ");
    parameterLines.push(`${safeParameterName(name)}: ${shown} — ${parameterStatus(name, values, query, effectiveSecurity)}`);
    if (!isSupportedParameter(name, values, effectiveSecurity, query)) unsupported.add(name);
  });

  query.forEach(([name, value]) => {
    if (emitted.has(name) && PARAMETER_NAMES.includes(name)) {
      return;
    }
    const values = valuesFor(query, [name]);
    const shown = values.map((item) => displayValue(name, item)).join(", ");
    parameterLines.push(`${safeParameterName(name)}: ${shown} — ${parameterStatus(name, values, query, effectiveSecurity)}`);
    emitted.add(name);
    if (!isSupportedParameter(name, values, effectiveSecurity, query)) unsupported.add(safeParameterName(name));
  });

  const aliasPairs = [["sni", "serverName"], ["pbk", "publicKey"], ["sid", "shortId"]];
  aliasPairs.forEach(([first, second]) => {
    const firstValueText = firstValue(query, [first]);
    const secondValueText = firstValue(query, [second]);
    if (firstValueText && secondValueText && firstValueText !== secondValueText) {
      warnings.push(`Conflicting aliases "${first}" and "${second}" were found.`);
      unsupported.add(first);
      unsupported.add(second);
    }
  });
  counts.forEach((count, name) => {
    if (count > 1 && name !== "alpn") unsupported.add(safeParameterName(name));
  });
  if (effectiveSecurity === "reality") {
    if (!hasValidRealityKey(query)) {
      unsupported.add("pbk");
      unsupported.add("publicKey");
      warnings.push("Reality security requires a valid pbk or publicKey parameter.");
    }
  }

  const isVlessUri = Boolean(parsed && parsed.protocol.toLowerCase() === "vless:");
  const typeValue = firstValue(query, ["type"]);
  const transportSupported = !typeValue || typeValue === "tcp";
  const realitySupported = effectiveSecurity === "reality";
  const realityKeyValid = hasValidRealityKey(query);
  const visionSupported = flow === "" || (flow === "xtls-rprx-vision" && realitySupported && realityKeyValid);
  const tlsSupported = ["none", "tls", "reality"].includes(effectiveSecurity);
  const securitySupported = tlsSupported && (effectiveSecurity !== "reality" || realityKeyValid);
  const choobsVersion = clean(options.choobsVersion || "0.1.0", 40);
  const coreVersion = clean(options.coreVersion || "sing-box v1.10.7 (pinned build; runtime version not queried)", 120);
  const report = [
    "CHOOBS VLESS DIAGNOSTIC",
    "",
    `Protocol: ${isVlessUri ? "VLESS" : "Unknown"}`,
    "Server: [MASKED]",
    `Port: ${port || "[NOT FOUND]"}`,
    `UUID: ${uuid ? "[MASKED]" : "[NOT FOUND]"}`,
    parsed && parsed.password ? "Password user-info: [MASKED]" : "Password user-info: [NOT FOUND]",
    "",
    "Transport:",
    `Type: ${typeValue ? displayValue("type", typeValue) : clean(network, 80)} — ${transportSupported ? "SUPPORTED" : "NOT SUPPORTED"}`,
    `Security: ${securityValues.length ? displayValue("security", security) : "[NOT FOUND]"} — ${securitySupported ? "SUPPORTED (none/TLS/Reality only)" : "NOT SUPPORTED"}`,
    `Flow: ${flowValues.length ? displayValue("flow", flow) : "[NOT FOUND]"} — ${visionSupported ? (flowValues.length ? "SUPPORTED (Vision with Reality only)" : "NOT FOUND") : "NOT SUPPORTED"}`,
    `Mode: ${modeValues.length ? displayValue("mode", mode) : "[NOT FOUND]"} — ${modeValues.length ? "NOT SUPPORTED BY CURRENT RUNTIME" : "NOT FOUND"}`,
    "",
    "Parameters:",
    ...parameterLines.map((line) => `- ${line}`),
    "",
    "Compatibility:",
    `- VLESS: ${isVlessUri ? "PARTIAL; only current generator-supported VLESS settings are usable" : "NOT DETERMINED; URI scheme is not VLESS"}`,
    `- TCP: ${transportSupported && (!typeValue || typeValue === "tcp") ? "SUPPORTED (default when type is absent)" : "NOT SUPPORTED"}`,
    `- XHTTP: ${typeValue === "xhttp" ? "NOT SUPPORTED" : "NOT FOUND"}`,
    `- WebSocket: ${typeValue === "ws" ? "NOT SUPPORTED" : "NOT FOUND"}`,
    `- gRPC: ${typeValue === "grpc" ? "NOT SUPPORTED" : "NOT FOUND"}`,
    `- Reality: ${realitySupported ? (realityKeyValid ? "PARTIAL; supported by current VLESS generator" : "NOT COMPATIBLE; valid public key missing") : "NOT FOUND"}`,
    `- TLS: ${effectiveSecurity === "tls" ? "PARTIAL; supported by current VLESS generator" : "NOT FOUND"}`,
    `- Vision: ${flow === "xtls-rprx-vision" ? (visionSupported ? "PARTIAL; Reality flow supported" : "NOT SUPPORTED without valid Reality settings") : "NOT FOUND"}`,
    `- host: ${counts.has("host") ? "FOUND; not implemented by current generator" : "NOT FOUND"}`,
    `- path: ${counts.has("path") ? "FOUND; not implemented by current generator" : "NOT FOUND"}`,
    `- serviceName: ${counts.has("serviceName") ? "FOUND; not implemented by current generator" : "NOT FOUND"}`,
    "",
    "Unsupported parameters:",
    ...(unsupported.size ? Array.from(unsupported).map((name) => `- ${safeParameterName(name)}`) : ["- None identified."]),
    "",
    "Parser warnings:",
    ...(warnings.length ? Array.from(new Set(warnings)).map((warning) => `- ${warning}`) : ["- None."]),
    "",
    `Choobs version: ${choobsVersion}`,
    `Core version: ${coreVersion}`,
    `Diagnostic format version: ${FORMAT_VERSION}`,
    ""
  ];

  return report.join("\n");
}

module.exports = { createVlessDiagnostic };
