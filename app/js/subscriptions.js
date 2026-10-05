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
    while (normalized.length % 4) normalized += "=";

    try {
      var binary = global.atob(normalized);
      var encoded = "";
      for (var index = 0; index < binary.length; index += 1) {
        encoded += `%${(`00${binary.charCodeAt(index).toString(16)}`).slice(-2)}`;
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
    if (!text) return [];

    try {
      var decodedUri = decodeURIComponent(text);
      if (decodedUri.indexOf("://") !== -1) text = decodedUri;
    } catch (error) {
      // Keep the source text when it contains percent-encoded URL fragments.
    }

    if (text.indexOf("://") === -1 && !/^\s*\{/.test(text)) {
      var decodedBase64 = decodeBase64(text);
      if (decodedBase64 && decodedBase64.indexOf("://") !== -1) text = decodedBase64;
    }

    return text.split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(Boolean);
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

  function serverFromUri(uri, subscriptionId, index) {
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
      var parsed = new URL(normalizedUri);
      var address = parsed.hostname;
      var port = parsed.port ? Number(parsed.port) : defaultPort(protocol);
      if (!address || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      var remark = parsed.hash ? decodeRemark(parsed.hash.slice(1)) : "";
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
    var lines = decodeSubscriptionContent(content);
    var servers = [];
    var skipped = 0;

    lines.forEach(function (line) {
      var server = serverFromUri(line, subscriptionId, servers.length);
      if (server) servers.push(server);
      else skipped += 1;
    });

    return { servers: servers, skipped: skipped };
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
    var content = await global.ChoobsStorage.fetchSubscription(normalizedUrl);
    var parsed = parseSubscription(content, subscriptionId);
    if (!parsed.servers.length) {
      throw new Error("No supported VPN servers were found in this subscription.");
    }

    return {
      subscription: {
        id: subscriptionId,
        name: name,
        url: normalizedUrl,
        updatedAt: new Date().toISOString(),
        servers: parsed.servers
      },
      skipped: parsed.skipped
    };
  }

  async function add(config, name, url) {
    var normalizedName = String(name || "").trim();
    if (!normalizedName) throw new Error("Enter a subscription name.");
    var id = makeId("subscription");
    var fetched = await fetchAndParse(normalizedName, url, id);
    var updated = cloneConfig(config);
    updated.subscriptions.push(fetched.subscription);
    updated.servers = updated.servers.concat(fetched.subscription.servers);
    if (!updated.selectedServerId) updated.selectedServerId = fetched.subscription.servers[0].id;
    return { config: updated, skipped: fetched.skipped };
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
    return { config: updated, skipped: fetched.skipped };
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
        return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
      } catch (error) {
        return url;
      }
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = global.SubscriptionManager;
  }
}(typeof window !== "undefined" ? window : globalThis));
