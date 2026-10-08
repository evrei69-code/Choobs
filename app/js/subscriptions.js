(function (global) {
  var nextId = 0;
  var protocolByScheme = {
    vless: "VLESS",
    vmess: "VMess",
    trojan: "Trojan",
    ss: "Shadowsocks",
    socks5: "SOCKS5",
    https: "HTTPS"
  };
  var knownPlaces = [
    { names: ["netherlands"], flag: "🇳🇱" },
    { names: ["germany"], flag: "🇩🇪" },
    { names: ["finland"], flag: "🇫🇮" },
    { names: ["united states", "usa"], flag: "🇺🇸" },
    { names: ["united kingdom", "uk"], flag: "🇬🇧" },
    { names: ["france"], flag: "🇫🇷" },
    { names: ["japan"], flag: "🇯🇵" },
    { names: ["singapore"], flag: "🇸🇬" },
    { names: ["sweden"], flag: "🇸🇪" },
    { names: ["switzerland"], flag: "🇨🇭" },
    { names: ["canada"], flag: "🇨🇦" },
    { names: ["australia"], flag: "🇦🇺" },
    { names: ["poland"], flag: "🇵🇱" },
    { names: ["estonia"], flag: "🇪🇪" },
    { names: ["latvia"], flag: "🇱🇻" },
    { names: ["lithuania"], flag: "🇱🇹" },
    { names: ["austria"], flag: "🇦🇹" },
    { names: ["italy"], flag: "🇮🇹" },
    { names: ["spain"], flag: "🇪🇸" },
    { names: ["norway"], flag: "🇳🇴" },
    { names: ["denmark"], flag: "🇩🇰" },
    { names: ["belgium"], flag: "🇧🇪" },
    { names: ["ireland"], flag: "🇮🇪" },
    { names: ["south korea", "korea"], flag: "🇰🇷" },
    { names: ["hong kong"], flag: "🇭🇰" },
    { names: ["turkey"], flag: "🇹🇷" },
    { names: ["uae", "united arab emirates"], flag: "🇦🇪" },
    { names: ["netherlands", "amsterdam"], city: "Amsterdam" },
    { names: ["frankfurt"], city: "Frankfurt" },
    { names: ["helsinki"], city: "Helsinki" },
    { names: ["tokyo"], city: "Tokyo" },
    { names: ["london"], city: "London" },
    { names: ["paris"], city: "Paris" },
    { names: ["new york"], city: "New York" },
    { names: ["los angeles"], city: "Los Angeles" },
    { names: ["singapore"], city: "Singapore" },
    { names: ["stockholm"], city: "Stockholm" },
    { names: ["zurich"], city: "Zurich" },
    { names: ["warsaw"], city: "Warsaw" },
    { names: ["tallinn"], city: "Tallinn" },
    { names: ["riga"], city: "Riga" },
    { names: ["vilnius"], city: "Vilnius" },
    { names: ["vienna"], city: "Vienna" },
    { names: ["milan"], city: "Milan" },
    { names: ["madrid"], city: "Madrid" },
    { names: ["oslo"], city: "Oslo" },
    { names: ["copenhagen"], city: "Copenhagen" },
    { names: ["brussels"], city: "Brussels" },
    { names: ["dublin"], city: "Dublin" },
    { names: ["seoul"], city: "Seoul" },
    { names: ["istanbul"], city: "Istanbul" }
  ];
  var countryCodes = ["NL", "DE", "FI", "US", "GB", "FR", "JP", "SG", "SE", "CH", "CA", "AU", "PL", "EE", "LV", "LT", "AT", "IT", "ES", "NO", "DK", "BE", "IE", "KR", "HK", "TR", "AE"];

  function makeId(prefix) {
    nextId += 1;
    return `${prefix}-${Date.now()}-${nextId}`;
  }

  function decodeBase64(value) {
    var normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
    var firstPadding = normalized.indexOf("=");
    if (firstPadding !== -1 && normalized.length % 4 !== 0) return null;
    var unpaddedLength = firstPadding === -1 ? normalized.length : firstPadding;
    if (unpaddedLength % 4 === 1) return null;
    normalized = normalized.slice(0, unpaddedLength);
    while (normalized.length % 4) normalized += "=";

    try {
      var binary = "";
      var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      for (var index = 0; index < normalized.length; index += 4) {
        var first = alphabet.indexOf(normalized.charAt(index));
        var second = alphabet.indexOf(normalized.charAt(index + 1));
        var third = normalized.charAt(index + 2) === "=" ? 0 : alphabet.indexOf(normalized.charAt(index + 2));
        var fourth = normalized.charAt(index + 3) === "=" ? 0 : alphabet.indexOf(normalized.charAt(index + 3));
        if (first < 0 || second < 0 || third < 0 || fourth < 0) return null;
        binary += String.fromCharCode((first << 2) | (second >> 4));
        if (normalized.charAt(index + 2) !== "=") binary += String.fromCharCode(((second & 15) << 4) | (third >> 2));
        if (normalized.charAt(index + 3) !== "=") binary += String.fromCharCode(((third & 3) << 6) | fourth);
      }

      var encoded = "";
      for (var byteIndex = 0; byteIndex < binary.length; byteIndex += 1) {
        encoded += `%${(`00${binary.charCodeAt(byteIndex).toString(16)}`).slice(-2)}`;
      }
      try {
        return decodeURIComponent(encoded);
      } catch (error) {
        return binary;
      }
    } catch (error) {
      return null;
    }
  }

  function decodeSubscriptionContent(content) {
    var text = String(content || "").replace(/^\uFEFF/, "").trim();
    if (!text) return { lines: [], format: "empty" };

    if (text.indexOf("://") === -1) {
      try {
        var decodedUri = decodeURIComponent(text);
        if (/^[a-z][a-z0-9+.-]*:\/\//im.test(decodedUri)) {
          text = decodedUri;
          return {
            lines: splitSubscriptionLines(text),
            format: "percent-encoded URI list"
          };
        }
      } catch (error) {
        // Keep the source text when it contains percent-encoded subscription content.
      }
    }

    if (!/^[a-z][a-z0-9+.-]*:\/\//im.test(text) && !/^\s*\{/.test(text)) {
      var decodedBase64 = decodeBase64(text);
      if (decodedBase64 && /^[a-z][a-z0-9+.-]*:\/\//im.test(decodedBase64.trim())) {
        text = decodedBase64;
        return {
          lines: splitSubscriptionLines(text),
          format: "base64 URI list"
        };
      }
    }

    return {
      lines: splitSubscriptionLines(text),
      format: /^[a-z][a-z0-9+.-]*:\/\//im.test(text) ? "URI list" : "unrecognized"
    };
  }

  function splitSubscriptionLines(text) {
    return text.split(/\r\n?|\n/).map(function (line) {
      return line.replace(/^\uFEFF+/, "").trim();
    }).filter(Boolean);
  }

  function contentByteLength(value) {
    if (typeof global.TextEncoder === "function") {
      return new global.TextEncoder().encode(value).length;
    }
    return unescape(encodeURIComponent(value)).length;
  }

  function decodeRemark(value) {
    try {
      return decodeURIComponent(value.replace(/\+/g, "%20"));
    } catch (error) {
      return value;
    }
  }

  function placeFromRemark(remark) {
    var lower = remark.toLowerCase();
    var place = { flag: "🌐", location: "Location unavailable" };

    knownPlaces.forEach(function (entry) {
      if (entry.flag && remark.indexOf(entry.flag) !== -1) place.flag = entry.flag;
      if (!entry.flag && !entry.city) return;
      if (!entry.names.some(function (name) { return lower.indexOf(name) !== -1; })) return;
      if (entry.flag) place.flag = entry.flag;
      if (entry.city) place.location = entry.city;
    });
    countryCodes.some(function (code) {
      if (new RegExp(`(^|[^a-z])${code.toLowerCase()}([^a-z]|$)`).test(lower)) {
        place.flag = String.fromCodePoint(127397 + code.charCodeAt(0), 127397 + code.charCodeAt(1));
        return true;
      }
      return false;
    });

    return place;
  }

  function serverName(remark, index) {
    var name = String(remark || "").trim();
    if (!name || name.length > 80 || /^[a-z0-9+.-]+:\/\//i.test(name)) return `Server ${index + 1}`;
    return name;
  }

  function defaultPort(protocol) {
    return protocol === "SOCKS5" ? 1080 : (protocol === "Shadowsocks" ? 8388 : 443);
  }

  function parseUriAuthority(uri, scheme, protocol) {
    var rest = uri.slice(scheme.length + 3);
    var end = rest.search(/[/?#]/);
    var authority = end === -1 ? rest : rest.slice(0, end);
    var at = authority.lastIndexOf("@");
    var hostPort = at === -1 ? authority : authority.slice(at + 1);
    if (!hostPort) return null;

    var hostname;
    var portText = "";
    if (hostPort.charAt(0) === "[") {
      var closingBracket = hostPort.indexOf("]");
      if (closingBracket === -1) return null;
      hostname = hostPort.slice(1, closingBracket);
      var suffix = hostPort.slice(closingBracket + 1);
      if (suffix && suffix.charAt(0) !== ":") return null;
      portText = suffix ? suffix.slice(1) : "";
      try {
        new URL(`http://[${hostname}]/`);
      } catch (error) {
        return null;
      }
    } else {
      var colon = hostPort.lastIndexOf(":");
      if (colon !== -1) {
        if (hostPort.indexOf(":") !== colon) return null;
        hostname = hostPort.slice(0, colon);
        portText = hostPort.slice(colon + 1);
      } else {
        hostname = hostPort;
      }
    }

    try {
      hostname = decodeURIComponent(hostname);
    } catch (error) {
      return null;
    }
    if (!hostname || /[\s/@?#]/.test(hostname)) return null;
    if (portText && !/^\d+$/.test(portText)) return null;
    if (hostPort.endsWith(":") || (portText && !portText.trim())) return null;
    var port = portText ? Number(portText) : defaultPort(protocol);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { hostname: hostname, port: port };
  }

  function parsedUriEndpoint(uri, scheme, protocol) {
    try {
      var parsed = new URL(uri);
      var address = parsed.hostname;
      var port = parsed.port ? Number(parsed.port) : defaultPort(protocol);
      if (address && Number.isInteger(port) && port >= 1 && port <= 65535) {
        return { hostname: address, port: port };
      }
    } catch (error) {
      // Some older URL implementations reject otherwise usable custom-scheme authorities.
    }
    return parseUriAuthority(uri, scheme, protocol);
  }

  function safeQueryParameterNames(uri) {
    var queryStart = uri.indexOf("?");
    if (queryStart === -1) return [];
    var queryEnd = uri.indexOf("#", queryStart);
    var query = uri.slice(queryStart + 1, queryEnd === -1 ? uri.length : queryEnd);
    var names = [];
    query.split("&").forEach(function (part) {
      if (!part) return;
      var rawName = part.split("=")[0].replace(/\+/g, " ");
      var name;
      try {
        name = decodeURIComponent(rawName);
      } catch (error) {
        return;
      }
      if (/^[A-Za-z0-9_.-]{1,40}$/.test(name) && names.indexOf(name) === -1) names.push(name);
    });
    return names;
  }

  function diagnoseUriLine(line, server) {
    var schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(line);
    var scheme = schemeMatch ? schemeMatch[1].toLowerCase() : "";
    var knownScheme = Object.prototype.hasOwnProperty.call(protocolByScheme, scheme);
    var validUri = false;
    var diagnosticEndpoint = null;
    if (scheme) {
      if (scheme === "vmess") {
        var vmessMatch = /^vmess:\/\/([^#]+)(?:#[^\r\n]*)?$/i.exec(line);
        if (vmessMatch) {
          var vmessText = decodeBase64(vmessMatch[1]);
          if (vmessText) {
            try {
              var vmessData = JSON.parse(vmessText);
              diagnosticEndpoint = {
                hostname: typeof vmessData.add === "string" ? vmessData.add : ""
              };
              validUri = Boolean(diagnosticEndpoint.hostname)
                && Number.isInteger(Number(vmessData.port))
                && Number(vmessData.port) >= 1
                && Number(vmessData.port) <= 65535;
            } catch (error) {
              validUri = false;
            }
          }
        }
      } else if (knownScheme) {
        diagnosticEndpoint = parsedUriEndpoint(line, scheme, protocolByScheme[scheme]);
        validUri = diagnosticEndpoint !== null;
      } else {
        try {
          new URL(line);
          validUri = true;
        } catch (error) {
          validUri = false;
        }
        diagnosticEndpoint = parseUriAuthority(line, scheme, "");
      }
    }

    var reason = "parsed";
    if (!scheme) {
      reason = /:\/\//.test(line) ? "invalid scheme syntax" : "missing URI scheme";
    } else if (!knownScheme) {
      reason = "unsupported scheme";
    } else if (!server) {
      if (scheme === "vmess") {
        var payload = line.slice("vmess://".length).split("#")[0];
        var decoded = decodeBase64(payload);
        if (!decoded) {
          reason = "invalid VMess Base64 payload";
        } else {
          try {
            var vmess = JSON.parse(decoded);
            var vmessPort = Number(vmess.port);
            reason = typeof vmess.add !== "string" || !vmess.add.trim()
              ? "missing VMess address"
              : (!Number.isInteger(vmessPort) || vmessPort < 1 || vmessPort > 65535
                ? "invalid VMess port" : "VMess record rejected");
          } catch (error) {
            reason = "invalid VMess JSON";
          }
        }
      } else if (!parsedUriEndpoint(line, scheme, protocolByScheme[scheme])) {
        reason = "invalid or unsupported URI authority";
      } else {
        reason = "URI parser rejected record";
      }
    }

    var hasInvisible = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/.test(line);
    return {
      scheme: scheme || "unrecognized",
      length: line.length,
      validUri: validUri,
      queryParameterNames: safeQueryParameterNames(line),
      startsWithExpectedScheme: schemeMatch !== null && knownScheme,
      hostnameLength: server ? server.address.length
        : (diagnosticEndpoint && diagnosticEndpoint.hostname ? diagnosticEndpoint.hostname.length : null),
      invisibleCharactersPresent: hasInvisible,
      reason: hasInvisible && !server ? `${reason}; invisible character present` : reason
    };
  }

  function serverFromUri(uri, subscriptionId, index) {
    if (/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/.test(uri)) return null;
    var vmessMatch = /^vmess:\/\/(.+)$/i.exec(uri);
    if (vmessMatch) {
      var decodedVmess = decodeBase64(vmessMatch[1].split("#")[0]);
      if (!decodedVmess) return null;
      try {
        var vmess = JSON.parse(decodedVmess);
        var vmessAddress = typeof vmess.add === "string" ? vmess.add.trim() : "";
        var vmessPort = Number(vmess.port);
        if (!vmessAddress || !Number.isInteger(vmessPort) || vmessPort < 1 || vmessPort > 65535) return null;
        var vmessRemark = typeof vmess.ps === "string" ? vmess.ps.trim() : "";
        var vmessPlace = placeFromRemark(vmessRemark);
        return {
          id: makeId("server"),
          name: serverName(vmessRemark, index),
          location: vmessPlace.location,
          flag: vmessPlace.flag,
          address: vmessAddress,
          port: vmessPort,
          protocol: "VMess",
          source: subscriptionId,
          ping: null,
          uri: uri,
          config: vmess
        };
      } catch (error) {
        return null;
      }
    }

    var match = /^([a-z0-9+.-]+):\/\/(.+)$/i.exec(uri);
    if (!match) return null;
    var scheme = match[1].toLowerCase();
    var protocol = Object.prototype.hasOwnProperty.call(protocolByScheme, scheme)
      ? protocolByScheme[scheme]
      : "";
    if (!protocol) return null;
    var normalizedUri = uri;

    if (protocol === "Shadowsocks" && match[2].indexOf("@") === -1) {
      var encodedServer = match[2].split("#")[0];
      var decodedServer = decodeBase64(encodedServer);
      if (!decodedServer || decodedServer.indexOf("@") === -1) return null;
      normalizedUri = `ss://${decodedServer}${match[2].indexOf("#") === -1 ? "" : `#${match[2].split("#").slice(1).join("#")}`}`;
    }

    try {
      var endpoint = parsedUriEndpoint(normalizedUri, scheme, protocol);
      if (!endpoint) return null;
      var address = endpoint.hostname;
      var port = endpoint.port;
      var hashIndex = normalizedUri.indexOf("#");
      var remark = hashIndex === -1 ? "" : decodeRemark(normalizedUri.slice(hashIndex + 1));
      var place = placeFromRemark(remark);
      return {
        id: makeId("server"),
        name: serverName(remark, index),
        location: place.location,
        flag: place.flag,
        address: address,
        port: port,
        protocol: protocol,
        source: subscriptionId,
        ping: null,
        uri: uri
      };
    } catch (error) {
      return null;
    }
  }

  function parseSubscription(content, subscriptionId) {
    var response = content && typeof content === "object" && typeof content.text === "string"
      ? content
      : { text: String(content || ""), diagnostics: {} };
    var decoded = decodeSubscriptionContent(response.text);
    var lines = decoded.lines;
    var servers = [];
    var skipped = 0;
    var protocolCounts = {
      VLESS: 0,
      VMess: 0,
      Trojan: 0,
      Shadowsocks: 0,
      SOCKS5: 0,
      HTTPS: 0,
      "Other/unsupported": 0
    };
    var uriLikeLines = 0;
    var uriDiagnostics = [];

    lines.forEach(function (line) {
      var schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(line);
      if (schemeMatch) uriLikeLines += 1;
      var server = serverFromUri(line, subscriptionId, servers.length);
      uriDiagnostics.push(diagnoseUriLine(line, server));
      if (server) {
        servers.push(server);
        if (Object.prototype.hasOwnProperty.call(protocolCounts, server.protocol)) {
          protocolCounts[server.protocol] += 1;
        } else {
          protocolCounts["Other/unsupported"] += 1;
        }
      } else {
        skipped += 1;
        if (schemeMatch && !Object.prototype.hasOwnProperty.call(protocolByScheme, schemeMatch[1].toLowerCase())) {
          protocolCounts["Other/unsupported"] += 1;
        }
      }
    });

    var fetchDiagnostics = response.diagnostics || {};
    return {
      servers: servers,
      skipped: skipped,
      diagnostics: {
        httpStatus: Number.isInteger(fetchDiagnostics.httpStatus) ? fetchDiagnostics.httpStatus : null,
        contentType: typeof fetchDiagnostics.contentType === "string" ? fetchDiagnostics.contentType : "unknown",
        responseBytes: Number.isInteger(fetchDiagnostics.responseBytes)
          ? fetchDiagnostics.responseBytes
          : contentByteLength(response.text),
        format: decoded.format,
        lineCount: lines.length,
        uriLikeLines: uriLikeLines,
        protocols: protocolCounts,
        uriLines: uriDiagnostics
      }
    };
  }

  function noSupportedServersError(diagnostics) {
    var protocols = diagnostics.protocols;
    var status = diagnostics.httpStatus === null ? "unknown" : diagnostics.httpStatus;
    if (global.console && typeof global.console.warn === "function") {
      global.console.warn("Choobs safe subscription URI diagnostics:", diagnostics.uriLines);
    }
    return new Error(
      `No supported VPN servers were found in this subscription. `
      + `Fetch: HTTP ${status}, ${diagnostics.contentType}, ${diagnostics.responseBytes} bytes; `
      + `decoded: ${diagnostics.format}, ${diagnostics.lineCount} lines, ${diagnostics.uriLikeLines} URI-like; `
      + `VLESS ${protocols.VLESS}, VMess ${protocols.VMess}, Trojan ${protocols.Trojan}, `
      + `Shadowsocks ${protocols.Shadowsocks}, SOCKS5 ${protocols.SOCKS5}, HTTPS ${protocols.HTTPS}, `
      + `other/unsupported ${protocols["Other/unsupported"]}.`
    );
  }

  function normalizeSubscriptionUrl(value) {
    var parsed;
    try {
      parsed = new URL(String(value || "").trim());
    } catch (error) {
      throw new Error("Enter a valid subscription URL.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Subscription URL must use HTTP or HTTPS.");
    }
    if (!parsed.hostname || parsed.username || parsed.password) {
      throw new Error("Subscription URL must have a host and must not include login credentials.");
    }
    return parsed.href;
  }

  function cloneConfig(config) {
    return {
      servers: config.servers.map(function (server) { return Object.assign({}, server); }),
      subscriptions: (config.subscriptions || []).map(function (subscription) {
        return Object.assign({}, subscription, {
          servers: (subscription.servers || []).map(function (server) { return Object.assign({}, server); })
        });
      }),
      selectedServerId: config.selectedServerId,
      settings: Object.assign({}, config.settings)
    };
  }

  async function fetchAndParse(name, url, subscriptionId) {
    var normalizedUrl = normalizeSubscriptionUrl(url);
    var normalizedName = String(name || "").trim() || "My subscription";
    var response = await global.ChoobsStorage.fetchSubscription(normalizedUrl);
    var parsed = parseSubscription(response, subscriptionId);
    if (!parsed.servers.length) {
      throw noSupportedServersError(parsed.diagnostics);
    }

    return {
      subscription: {
        id: subscriptionId,
        name: normalizedName,
        url: normalizedUrl,
        updatedAt: new Date().toISOString(),
        servers: parsed.servers
      },
      skipped: parsed.skipped,
      diagnostics: parsed.diagnostics
    };
  }

  async function add(config, name, url) {
    var id = makeId("subscription");
    var fetched = await fetchAndParse(name, url, id);
    var updated = cloneConfig(config);
    updated.subscriptions.push(fetched.subscription);
    updated.servers = updated.servers.concat(fetched.subscription.servers);
    if (!updated.selectedServerId) updated.selectedServerId = fetched.subscription.servers[0].id;
    return { config: updated, skipped: fetched.skipped, diagnostics: fetched.diagnostics };
  }

  async function refresh(config, subscriptionId) {
    var previous = config.subscriptions.find(function (item) { return item.id === subscriptionId; });
    if (!previous) throw new Error("Subscription no longer exists.");
    var fetched = await fetchAndParse(previous.name, previous.url, previous.id);
    var previousByUri = {};
    (previous.servers || []).forEach(function (server) {
      if (!server.uri) return;
      if (!previousByUri[server.uri]) previousByUri[server.uri] = [];
      previousByUri[server.uri].push(server);
    });
    fetched.subscription.servers = fetched.subscription.servers.map(function (server) {
      var matching = server.uri && previousByUri[server.uri] ? previousByUri[server.uri].shift() : null;
      if (!matching) return server;
      server.id = matching.id;
      return server;
    });
    var updated = cloneConfig(config);
    updated.servers = updated.servers.filter(function (server) {
      return server.source !== subscriptionId;
    }).concat(fetched.subscription.servers);
    updated.subscriptions = updated.subscriptions.map(function (item) {
      return item.id === subscriptionId ? fetched.subscription : item;
    });
    if (!updated.servers.some(function (server) { return server.id === updated.selectedServerId; })) {
      updated.selectedServerId = updated.servers.length ? updated.servers[0].id : null;
    }
    return { config: updated, skipped: fetched.skipped, diagnostics: fetched.diagnostics };
  }

  function remove(config, subscriptionId) {
    var updated = cloneConfig(config);
    updated.subscriptions = updated.subscriptions.filter(function (item) { return item.id !== subscriptionId; });
    updated.servers = updated.servers.filter(function (server) { return server.source !== subscriptionId; });
    if (!updated.servers.some(function (server) { return server.id === updated.selectedServerId; })) {
      updated.selectedServerId = updated.servers.length ? updated.servers[0].id : null;
    }
    return updated;
  }

  function importData(data, config) {
    var input = Array.isArray(data) ? { servers: data, subscriptions: [] } : data;
    if (!input || typeof input !== "object") throw new Error("Import file must contain servers or subscriptions.");
    var importedSubscriptions = Array.isArray(input.subscriptions) ? input.subscriptions : [];
    var importedServers = Array.isArray(input.servers) ? input.servers : [];
    if (!importedSubscriptions.length && !importedServers.length) {
      throw new Error("Import file must contain at least one server or subscription.");
    }

    var updated = cloneConfig(config);
    var idMap = {};
    var addedSubscriptions = importedSubscriptions.map(function (subscription, subscriptionIndex) {
      if (!subscription || typeof subscription !== "object"
          || typeof subscription.name !== "string" || !subscription.name.trim()) {
        throw new Error(`Subscription ${subscriptionIndex + 1} is invalid.`);
      }
      var id = makeId("subscription");
      if (typeof subscription.id === "string") idMap[subscription.id] = id;
      var servers = Array.isArray(subscription.servers) ? subscription.servers : [];
      return {
        id: id,
        name: subscription.name.trim(),
        url: normalizeSubscriptionUrl(subscription.url),
        updatedAt: typeof subscription.updatedAt === "string" ? subscription.updatedAt : null,
        servers: servers.map(function (server, serverIndex) {
          var normalized = normalizeImportedServer(server, serverIndex, id);
          return normalized;
        })
      };
    });

    var subscriptionServerIds = {};
    addedSubscriptions.forEach(function (subscription) {
      var original = importedSubscriptions.find(function (item) {
        return item && idMap[item.id] === subscription.id;
      });
      (Array.isArray(original && original.servers) ? original.servers : []).forEach(function (server) {
        if (server && typeof server.id === "string") subscriptionServerIds[server.id] = true;
      });
    });
    var addedServers = importedServers.filter(function (server) {
      return !server || !subscriptionServerIds[server.id];
    }).map(function (server, index) {
      var source = server && idMap[server.source] ? idMap[server.source] : null;
      return normalizeImportedServer(server, index, source);
    });

    updated.subscriptions = updated.subscriptions.concat(addedSubscriptions);
    updated.servers = updated.servers.concat(addedSubscriptions.reduce(function (all, item) {
      return all.concat(item.servers);
    }, []), addedServers);
    if (!updated.selectedServerId && updated.servers.length) updated.selectedServerId = updated.servers[0].id;
    return updated;
  }

  function normalizeImportedServer(server, index, source) {
    if (!server || typeof server !== "object" || Array.isArray(server)
        || typeof server.name !== "string" || !server.name.trim()) {
      throw new Error(`Server ${index + 1} is invalid.`);
    }
    var port = typeof server.port === "undefined" ? 443 : Number(server.port);
    var protocol = typeof server.protocol === "string" ? server.protocol : "HTTPS";
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Server ${index + 1} has an invalid port.`);
    if (["VLESS", "VMess", "Trojan", "Shadowsocks", "SOCKS5", "HTTPS", "Custom"].indexOf(protocol) === -1) {
      throw new Error(`Server ${index + 1} uses an unsupported protocol.`);
    }
    return Object.assign({}, server, {
      id: makeId("server"),
      name: server.name.trim(),
      location: typeof server.location === "string" && server.location.trim() ? server.location.trim() : "Location unavailable",
      address: typeof server.address === "string" ? server.address : "",
      port: port,
      protocol: protocol,
      source: source || null,
      ping: null
    });
  }

  global.SubscriptionManager = {
    add: add,
    refresh: refresh,
    remove: remove,
    parse: parseSubscription,
    importData: importData,
    normalizeUrl: normalizeSubscriptionUrl,
    displayUrl: function (url) {
      try {
        var parsed = new URL(url);
        return parsed.hostname;
      } catch (error) {
        return "Subscription URL";
      }
    },
    diagnose: function (content) {
      return parseSubscription(content, "diagnostic").diagnostics.uriLines;
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.SubscriptionManager;
  }
}(typeof window !== "undefined" ? window : globalThis));
