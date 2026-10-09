const serverList = document.getElementById("serverList");
const serverCount = document.getElementById("serverCount");
const selectedServerLabel = document.getElementById("selectedServer");
const selectedLabel = document.getElementById("selectedLabel");
const connectButton = document.getElementById("connectButton");
const connectionOrbit = document.querySelector(".connection-orbit");
const status = document.getElementById("status");
const connectionStats = document.getElementById("connectionStats");
const connectionDuration = document.getElementById("connectionDuration");
const connectionPing = document.getElementById("connectionPing");
const settingsButton = document.getElementById("settingsButton");
const addSubscriptionButton = document.getElementById("addSubscription");
const refreshSubscriptionsButton = document.getElementById("refreshSubscriptions");
const bestServerButton = document.getElementById("bestServer");
const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalContent = document.getElementById("modalContent");
const modalActions = document.getElementById("modalActions");
const modalClose = document.getElementById("modalClose");
const toast = document.getElementById("toast");

const protocols = ["HTTPS", "SOCKS5", "VLESS", "VMess", "Trojan", "Shadowsocks", "Custom"];
let state;
let connected = false;
let connectionPending = false;
let connectionState = "disconnected";
let connectionStartedAt = null;
let connectionServerId = null;
let connectionDurationTimer = null;
let connectionFailure = "";
let pingResults = {};
let pingSweepRunning = false;
let subscriptionRefreshRunning = false;
let modalReturnFocus = null;
let serverIdSequence = 0;
let toastTimer = null;
let coreStatusTimer = null;

function makeElement(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (typeof text === "string") node.textContent = text;
  return node;
}

function defaultSettings() {
  return {
    startWithWindows: false,
    autoConnect: false,
    autoConnectBestServer: false,
    minimizeToTray: false,
    connectionMode: "System Proxy",
    rememberSelectedServer: true,
    connectOnStart: false,
    autoUpdateSubscriptions: false,
    subscriptionUpdateInterval: "manual"
  };
}

function transitionConnection(event) {
  const transition = window.ChoobsUIState.transitionConnection(connectionState, event);
  if (!transition.accepted) return false;
  connectionState = transition.state;
  connected = connectionState === "connected" || connectionState === "disconnecting";
  connectionPending = connectionState === "connecting" || connectionState === "disconnecting";
  return true;
}

function setConnectionStarted(server) {
  connectionStartedAt = Date.now();
  connectionServerId = server ? server.id : null;
  connectionFailure = "";
  if (connectionDurationTimer) window.clearInterval(connectionDurationTimer);
  connectionDurationTimer = window.setInterval(updateConnectionStats, 1000);
}

function stopConnectionDuration() {
  if (connectionDurationTimer) window.clearInterval(connectionDurationTimer);
  connectionDurationTimer = null;
  connectionStartedAt = null;
  connectionServerId = null;
}

function showModal(title, content, actions) {
  modalReturnFocus = document.activeElement;
  modalTitle.textContent = title;
  modalContent.textContent = "";
  modalContent.appendChild(content);
  modalActions.textContent = "";
  actions.forEach((action) => modalActions.appendChild(action));
  modalOverlay.hidden = false;
  document.body.classList.add("modal-open");

  const firstControl = modalContent.querySelector("input, select, textarea, button");
  if (firstControl) firstControl.focus();
  else modalClose.focus();
}

function closeModal() {
  modalOverlay.hidden = true;
  document.body.classList.remove("modal-open");
  modalContent.textContent = "";
  modalActions.textContent = "";
  if (modalReturnFocus && typeof modalReturnFocus.focus === "function") modalReturnFocus.focus();
}

function makeButton(text, className, onClick) {
  const button = makeElement("button", className, text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function notify(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("visible");
  }, 2800);
}

function selectedServer() {
  return state.servers.find((server) => server.id === state.selectedServerId) || null;
}

function monitorCoreStatus() {
  if (window.ChoobsStorage.isPreview || coreStatusTimer || !window.choobs) return;
  coreStatusTimer = window.setInterval(async () => {
    if (!connected) return;
    try {
      const currentStatus = await window.choobs.getCoreStatus();
      if (!connected) return;
      const proxyRecoveryNeeded = currentStatus && currentStatus.code === "PROXY_RESTORE_FAILED";
      if (!currentStatus || (!proxyRecoveryNeeded && currentStatus.state !== "running") ||
          (!currentStatus.running && !proxyRecoveryNeeded)) {
        transitionConnection("CORE_EXITED");
        connected = false;
        connectionFailure = currentStatus && currentStatus.error ? "Connection lost" : "";
        stopConnectionDuration();
        window.clearInterval(coreStatusTimer);
        coreStatusTimer = null;
        renderServers();
        updateConnectionView();
        notify(currentStatus && currentStatus.error
          ? `VPN connection lost: ${currentStatus.error}`
          : "VPN core stopped unexpectedly");
      } else if (proxyRecoveryNeeded) {
        connectionFailure = "Proxy restore needs attention";
        updateConnectionView();
      } else if (connectionFailure) {
        connectionFailure = "";
        updateConnectionView();
      }
    } catch (error) {
      connectionFailure = "Connection status unavailable";
      updateConnectionView();
    }
  }, 5000);
}

function syncConnectionFromCore(coreStatus) {
  if (!coreStatus) return;
  if (coreStatus.code === "PROXY_RESTORE_FAILED") {
    if (connectionState === "disconnecting") transitionConnection("RESTORE_FAILED");
    else {
      if (connectionState === "disconnected" || connectionState === "failed") transitionConnection("CONNECT");
      if (connectionState === "connecting") transitionConnection("CONNECTED");
      if (connectionState === "disconnecting") transitionConnection("DISCONNECT_FAILED");
    }
    connected = true;
    connectionFailure = "Proxy restore needs attention";
    if (!connectionStartedAt) setConnectionStarted(selectedServer());
  } else if (coreStatus.running && coreStatus.state === "running") {
    if (connectionState === "disconnected" || connectionState === "failed") transitionConnection("CONNECT");
    if (connectionState === "connecting") transitionConnection("CONNECTED");
    connected = true;
    if (!connectionStartedAt) setConnectionStarted(selectedServer());
    connectionFailure = "";
    monitorCoreStatus();
  } else if (coreStatus.state === "stopped" && connected) {
    transitionConnection("DISCONNECTED");
    connected = false;
    stopConnectionDuration();
  }
  renderServers();
  updateConnectionView();
}

function updateConnectionView() {
  const currentServer = connected
    ? state.servers.find((server) => server.id === connectionServerId) || selectedServer()
    : selectedServer();
  const labels = {
    disconnected: "Connect",
    connecting: "Connecting...",
    connected: "Disconnect",
    disconnecting: "Disconnecting...",
    failed: "Connect"
  };
  connectButton.textContent = labels[connectionState] || "Connect";
  connectButton.disabled = connectionPending || (!connected && !selectedServer());
  connectButton.classList.toggle("connected", connected && connectionState === "connected");
  connectButton.setAttribute("aria-pressed", String(connected));
  connectionOrbit.classList.toggle("connected", connected && connectionState === "connected");
  connectionOrbit.classList.toggle("connecting", connectionPending);
  status.textContent = connectionPending
    ? labels[connectionState]
    : (connectionState === "failed"
      ? "Connection failed"
      : (connectionFailure || (connected ? "Connected" : "Disconnected")));
  status.dataset.state = connectionState;
  status.dataset.warning = String(Boolean(connectionFailure && connected));
  connectionStats.hidden = !connected;
  selectedLabel.textContent = connected ? "CONNECTED SERVER" : "SELECTED SERVER";
  selectedServerLabel.textContent = currentServer
    ? `${currentServer.flag || "🌐"} ${currentServer.location || currentServer.name}`
    : "No server selected";
  if (connected && currentServer) {
    connectionPing.textContent = Number.isFinite(currentServer.ping) ? `Ping: ${currentServer.ping} ms` : "Ping: —";
  } else {
    connectionPing.textContent = "";
  }
  updateConnectionStats();
}

function updateConnectionStats() {
  if (!connected || !connectionStartedAt) {
    connectionDuration.textContent = "";
    return;
  }
  const elapsed = Math.max(0, Math.floor((Date.now() - connectionStartedAt) / 1000));
  const hours = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  connectionDuration.textContent = `Connected for ${hours}:${minutes}:${seconds}`;
}

function pingLabel(server) {
  const result = pingResults[server.id];
  if (result && result.status === "checking") return "Checking...";
  if (result && result.status === "timeout") return "Timeout";
  if (result && result.status === "unavailable") return "Unavailable";
  if (result && result.status === "available") return `${result.ping} ms`;
  return Number.isFinite(server.ping) ? `${server.ping} ms` : "—";
}

async function toggleFavorite(serverId) {
  const previousFavorites = state.favorites.slice();
  state.favorites = window.ChoobsUIState.toggleFavorite(state.favorites, serverId);
  renderServers();
  try {
    await persistConfig();
  } catch (error) {
    state.favorites = previousFavorites;
    renderServers();
    notify(`Could not save favorite: ${error.message}`);
  }
}

function renderServers() {
  serverList.textContent = "";
  serverCount.textContent = String(state.servers.length);
  refreshSubscriptionsButton.disabled = state.subscriptions.length === 0 || connectionPending || pingSweepRunning;
  refreshSubscriptionsButton.textContent = subscriptionRefreshRunning ? "Updating..." : "↻ Refresh";
  bestServerButton.disabled = state.servers.length === 0 || connectionPending || pingSweepRunning || subscriptionRefreshRunning;
  bestServerButton.textContent = pingSweepRunning ? "Checking..." : "Best server";
  const currentServer = selectedServer();
  addSubscriptionButton.disabled = connected || connectionPending || pingSweepRunning;

  if (state.servers.length === 0) {
    const empty = makeElement("div", "empty-servers");
    empty.appendChild(makeElement("strong", "", "Add a VPN subscription"));
    empty.appendChild(makeElement("span", "", "Your server locations will appear here after the subscription is loaded."));
    serverList.appendChild(empty);
    return;
  }

  const sortedServers = window.ChoobsUIState.sortServers(state.servers, state.favorites);
  sortedServers.forEach((server) => {
    const row = makeElement("div", "server-entry");
    if (!server.source) row.classList.add("manual");
    const button = makeElement("button", "server-card");
    const flag = makeElement("span", "server-flag", server.flag || "🌐");
    const info = makeElement("span", "server-info");
    const displayName = server.location && server.location !== "Location unavailable" ? server.location : server.name;
    const name = makeElement("span", "server-name", displayName);
    const reality = server.protocol === "VLESS" && /[?&]security=reality(?:&|#|$)/i.test(server.uri || "");
    const location = makeElement("span", "server-location", reality ? "VLESS Reality" : server.protocol);
    const ping = makeElement("span", "server-ping", pingLabel(server));
    const arrow = makeElement("span", "server-arrow", "›");
    const favorite = makeButton(state.favorites.indexOf(server.id) !== -1 ? "★" : "☆", "server-favorite", () => toggleFavorite(server.id));
    const edit = makeButton("⋯", "server-edit", () => openServerEditor(server));

    button.type = "button";
    button.setAttribute("aria-label", `${server.location || server.name}, ${pingLabel(server)}`);
    button.disabled = connected || connectionPending || pingSweepRunning;
    if (server.id === state.selectedServerId) {
      button.classList.add("selected");
      button.setAttribute("aria-pressed", "true");
    } else {
      button.setAttribute("aria-pressed", "false");
    }
    flag.setAttribute("role", "img");
    flag.setAttribute("aria-label", `${server.name} flag`);
    info.appendChild(name);
    info.appendChild(location);
    arrow.setAttribute("aria-hidden", "true");
    button.appendChild(flag);
    button.appendChild(info);
    button.appendChild(ping);
    button.appendChild(arrow);
    favorite.setAttribute("aria-label", state.favorites.indexOf(server.id) !== -1 ? "Remove from favorites" : "Add to favorites");
    favorite.setAttribute("aria-pressed", String(state.favorites.indexOf(server.id) !== -1));
    favorite.disabled = connectionPending;
    edit.setAttribute("aria-label", `Edit ${server.name}`);
    edit.title = "Edit server";
    edit.disabled = connected || connectionPending || pingSweepRunning;

    button.addEventListener("click", () => {
      if (connected || connectionPending) return;

      const previousId = state.selectedServerId;
      state.selectedServerId = server.id;
      renderServers();
      updateConnectionView();
      notify(`Ready • ${server.location}`);
      persistConfig().then(() => {
        notify(`Selected ${server.location}`);
      }).catch((error) => {
        state.selectedServerId = previousId;
        renderServers();
        updateConnectionView();
        notify(`Could not save selected server: ${error.message}`);
      });
    });

    row.appendChild(button);
    row.appendChild(favorite);
    if (!server.source) row.appendChild(edit);
    serverList.appendChild(row);
  });
}

function persistConfig() {
  return window.ChoobsStorage.saveConfig(state);
}

function copyConfig(config) {
  return {
    servers: config.servers.map((server) => Object.assign({}, server)),
    subscriptions: (config.subscriptions || []).map((subscription) => Object.assign({}, subscription, {
      servers: (subscription.servers || []).map((server) => Object.assign({}, server))
    })),
    favorites: (config.favorites || []).slice(),
    selectedServerId: config.selectedServerId,
    settings: Object.assign({}, config.settings)
  };
}

function addSettingsCheckbox(container, key, labelText) {
  const label = makeElement("label", "setting-option");
  const text = makeElement("span", "", labelText);
  const checkbox = makeElement("input", "setting-checkbox");
  checkbox.type = "checkbox";
  checkbox.checked = state.settings[key];
  checkbox.setAttribute("data-setting", key);
  label.appendChild(text);
  label.appendChild(checkbox);
  container.appendChild(label);
}

function addSettingsGroup(container, title) {
  const group = makeElement("section", "settings-group");
  group.appendChild(makeElement("h3", "settings-group-title", title));
  container.appendChild(group);
  return group;
}

function buildSettingsContent() {
  const content = makeElement("div", "settings-content");
  const connection = addSettingsGroup(content, "CONNECTION");
  addSettingsCheckbox(connection, "autoConnect", "Auto-connect on startup");
  addSettingsCheckbox(connection, "startWithWindows", "Start Choobs with Windows");
  addSettingsCheckbox(connection, "minimizeToTray", "Minimize to tray");
  addSettingsCheckbox(connection, "rememberSelectedServer", "Remember selected server");
  addSettingsCheckbox(connection, "autoConnectBestServer", "Use Best server if saved server is missing");

  const subscriptions = addSettingsGroup(content, "SUBSCRIPTIONS");
  if (state.subscriptions.length === 0) {
    subscriptions.appendChild(makeElement("p", "subscription-empty", "No subscriptions added yet."));
  } else {
    const refreshAll = makeButton("Refresh subscriptions", "secondary-button", refreshAllSubscriptions);
    refreshAll.disabled = subscriptionRefreshRunning || connected || connectionPending;
    subscriptions.appendChild(refreshAll);
    state.subscriptions.forEach((subscription) => {
      const card = makeElement("div", "subscription-card");
      const summary = makeElement("div", "subscription-summary");
      summary.appendChild(makeElement("strong", "", subscription.name));
      summary.appendChild(makeElement("span", "subscription-updated", `Last updated: ${formatUpdatedAt(subscription.updatedAt)}`));
      card.appendChild(summary);
      const controls = makeElement("div", "subscription-controls");
      const refresh = makeButton("Refresh", "secondary-button", () => refreshSubscription(subscription.id));
      const remove = makeButton("Remove", "danger-button", () => confirmRemoveSubscription(subscription));
      refresh.disabled = subscriptionRefreshRunning || connected || connectionPending || pingSweepRunning;
      remove.disabled = connected || connectionPending;
      controls.appendChild(refresh);
      controls.appendChild(remove);
      card.appendChild(controls);
      subscriptions.appendChild(card);
    });
  }
  subscriptions.appendChild(makeButton("Add subscription", "secondary-button", openAddSubscription));

  const vpn = addSettingsGroup(content, "VPN");
  vpn.appendChild(makeElement("p", "settings-note", "Traffic mode: System Proxy"));
  vpn.appendChild(makeElement("p", "settings-note", "Apps that bypass Windows proxy settings and some DNS requests may use your regular network."));

  const about = addSettingsGroup(content, "ABOUT");
  const aboutCard = makeElement("div", "about-card");
  aboutCard.appendChild(makeElement("strong", "", "Choobs"));
  aboutCard.appendChild(makeElement("span", "", "Version 0.1.0"));
  aboutCard.appendChild(makeElement("span", "", "VPN client for Windows"));
  about.appendChild(aboutCard);

  const dataActions = makeElement("div", "data-actions");
  dataActions.appendChild(makeButton("Import configuration", "secondary-button", importServers));
  dataActions.appendChild(makeButton("Export configuration", "secondary-button", exportServers));
  content.appendChild(dataActions);
  content.appendChild(makeElement("div", "modal-feedback", ""));
  return content;
}

function setModalFeedback(message, isError) {
  const feedback = modalContent.querySelector(".modal-feedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle("error", Boolean(isError));
}

function openSettings() {
  const content = buildSettingsContent();
  const save = makeButton("Save", "primary-button", async () => {
    const previousSettings = Object.assign({}, state.settings);
    const previousState = copyConfig(state);
    content.querySelectorAll("[data-setting]").forEach((control) => {
      const key = control.getAttribute("data-setting");
      state.settings[key] = control.type === "checkbox" ? control.checked : control.value;
    });

    try {
      await persistConfig();
      if (!window.ChoobsStorage.isPreview
          && previousSettings.startWithWindows !== state.settings.startWithWindows) {
        await window.ChoobsStorage.setStartWithWindows(state.settings.startWithWindows);
      }
      closeModal();
      notify("Settings saved");
    } catch (error) {
      state = previousState;
      renderServers();
      content.querySelectorAll("[data-setting]").forEach((control) => {
        const key = control.getAttribute("data-setting");
        if (control.type === "checkbox") control.checked = state.settings[key];
        else control.value = state.settings[key];
      });
      try {
        await persistConfig();
      } catch (rollbackError) {
        notify(`Could not restore saved settings: ${rollbackError.message}`);
      }
      setModalFeedback(`Could not save settings: ${error.message}`, true);
    }
  });
  const close = makeButton("Close", "secondary-button", closeModal);
  showModal("Settings", content, [close, save]);
}

function formatUpdatedAt(value) {
  if (!value) return "Never";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Never";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function openAddSubscription() {
  if (connected || connectionPending) {
    notify("Disconnect before changing subscriptions");
    return;
  }
  const returnToSettings = !modalOverlay.hidden && modalTitle.textContent === "Settings";
  const form = makeElement("form", "subscription-form");
  form.id = "subscriptionForm";
  const nameField = createField(form, "Subscription name (optional)", "subscription-name", { placeholder: "My subscription" });
  const urlField = createField(form, "Subscription URL", "subscription-url", {
    type: "text",
    placeholder: "https://example.com/subscription",
    wide: true
  });
  urlField.control.inputMode = "url";
  const feedback = makeElement("div", "modal-feedback", "");
  form.appendChild(feedback);
  const cancel = makeButton("Cancel", "secondary-button", () => {
    closeModal();
    if (returnToSettings) openSettings();
  });
  const add = makeButton("Add subscription", "primary-button", () => {});
  add.type = "submit";
  add.setAttribute("form", form.id);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    nameField.error.textContent = "";
    urlField.error.textContent = "";
    feedback.textContent = "";
    const name = nameField.control.value.trim();
    const url = urlField.control.value.trim();
    try {
      SubscriptionManager.normalizeUrl(url);
    } catch (error) {
      urlField.error.textContent = error.message;
      return;
    }

    add.disabled = true;
    add.textContent = "Loading…";
    const previousState = copyConfig(state);
    try {
      const result = await SubscriptionManager.add(state, name, url);
      state = result.config;
      await persistConfig();
      closeModal();
      renderServers();
      updateConnectionView();
      const addedSubscription = state.subscriptions[state.subscriptions.length - 1];
      const skipped = result.skipped ? `; ${result.skipped} unsupported entries skipped` : "";
      notify(`Subscription added — ${addedSubscription.servers.length} servers${skipped}`);
      if (returnToSettings) openSettings();
    } catch (error) {
      state = previousState;
      add.disabled = false;
      add.textContent = "Add subscription";
      feedback.textContent = error.message;
      feedback.classList.add("error");
    }
  });
  showModal("Add subscription", form, [cancel, add]);
}

async function refreshSubscription(subscriptionId) {
  if (subscriptionRefreshRunning || connected || connectionPending) {
    if (connected || connectionPending) notify("Disconnect before updating subscriptions");
    return false;
  }
  subscriptionRefreshRunning = true;
  renderServers();
  try {
    return await performSubscriptionRefresh(subscriptionId);
  } finally {
    subscriptionRefreshRunning = false;
    renderServers();
    if (!modalOverlay.hidden && modalTitle.textContent === "Settings") openSettings();
  }
}

async function performSubscriptionRefresh(subscriptionId) {
  const previousState = copyConfig(state);
  try {
    const result = await SubscriptionManager.refresh(state, subscriptionId);
    state = result.config;
    await persistConfig();
    renderServers();
    updateConnectionView();
    const subscription = state.subscriptions.find((item) => item.id === subscriptionId);
    notify(`Subscription updated — ${subscription.servers.length} servers`);
    if (result.skipped) notify(`${result.skipped} unsupported entries were skipped`);
    return true;
  } catch (error) {
    state = previousState;
    renderServers();
    updateConnectionView();
    notify(`Could not update subscription: ${error.message}`);
    return false;
  }
}

async function refreshAllSubscriptions() {
  if (!state.subscriptions.length) {
    notify("Add a subscription first");
    return;
  }
  if (subscriptionRefreshRunning || connected || connectionPending) return;
  subscriptionRefreshRunning = true;
  renderServers();
  try {
    let successes = 0;
    const subscriptionIds = state.subscriptions.map((subscription) => subscription.id);
    for (let index = 0; index < subscriptionIds.length; index += 1) {
      if (await performSubscriptionRefresh(subscriptionIds[index])) successes += 1;
    }
    if (successes === subscriptionIds.length) notify("All subscriptions updated");
    else if (successes) notify(`${successes} of ${subscriptionIds.length} subscriptions updated`);
  } finally {
    subscriptionRefreshRunning = false;
    renderServers();
    if (!modalOverlay.hidden && modalTitle.textContent === "Settings") openSettings();
  }
}

function confirmRemoveSubscription(subscription) {
  if (connected || connectionPending) {
    notify("Disconnect before changing subscriptions");
    return;
  }
  const content = makeElement("div", "delete-confirmation");
  content.appendChild(makeElement("p", "", `Remove “${subscription.name}” and all its servers?`));
  const cancel = makeButton("Cancel", "secondary-button", () => {
    closeModal();
    openSettings();
  });
  const remove = makeButton("Remove subscription", "danger-button", async () => {
    const previousState = copyConfig(state);
    state = SubscriptionManager.remove(state, subscription.id);
    try {
      await persistConfig();
      closeModal();
      renderServers();
      updateConnectionView();
      notify("Subscription removed");
      openSettings();
    } catch (error) {
      state = previousState;
      setModalFeedback(error.message, true);
    }
  });
  showModal("Remove subscription?", content, [cancel, remove]);
}

async function chooseBestServer() {
  if (!state.servers.length || pingSweepRunning || subscriptionRefreshRunning || connected || connectionPending) return;
  if (window.ChoobsStorage.isPreview) {
    notify("Latency checks require the desktop app; no mock values are shown");
    return;
  }
  pingSweepRunning = true;
  const servers = state.servers.slice();
  servers.forEach((server) => { pingResults[server.id] = { status: "checking", ping: null }; });
  renderServers();
  try {
    const best = await measureBestServer(servers);
    if (!best) {
      notify("No servers responded to the latency check");
      return;
    }
    const previousId = state.selectedServerId;
    state.selectedServerId = best.server.id;
    try {
      await persistConfig();
    } catch (error) {
      state.selectedServerId = previousId;
      throw error;
    }
    notify(`Best server: ${best.server.location || best.server.name} · ${best.result.ping} ms`);
  } catch (error) {
    notify(`Could not check server latency: ${error.message}`);
  } finally {
    pingSweepRunning = false;
    renderServers();
    updateConnectionView();
    persistConfig().catch((error) => notify(`Could not save latency results: ${error.message}`));
  }
}

async function measureBestServer(servers) {
  const results = await window.ChoobsUIState.measureServers(
    servers,
    (server) => window.ChoobsStorage.pingServer(server),
    (server, result) => {
      pingResults[server.id] = result;
      const current = state.servers.find((item) => item.id === server.id);
      if (current) current.ping = result.status === "available" ? result.ping : null;
      renderServers();
      updateConnectionView();
    },
    4
  );
  return window.ChoobsUIState.bestServer(results);
}

function createField(form, labelText, key, options) {
  const field = makeElement("div", `form-field${options && options.wide ? " form-field-wide" : ""}`);
  const label = makeElement("label", "form-label", labelText);
  let control;

  if (options && options.select) {
    control = makeElement("select", "form-control");
    options.select.forEach((value) => {
      const option = makeElement("option", "", value);
      option.value = value;
      control.appendChild(option);
    });
  } else if (options && options.textarea) {
    control = makeElement("textarea", "form-control");
    control.rows = 3;
  } else {
    control = makeElement("input", "form-control");
    control.type = options && options.type ? options.type : "text";
  }

  control.id = `server-${key}`;
  control.name = key;
  if (options && options.placeholder) control.placeholder = options.placeholder;
  if (options && options.min) control.min = options.min;
  if (options && options.max) control.max = options.max;
  if (options && options.step) control.step = options.step;
  label.htmlFor = control.id;
  field.appendChild(label);
  field.appendChild(control);
  const error = makeElement("span", "field-error", "");
  error.setAttribute("aria-live", "polite");
  field.appendChild(error);
  form.appendChild(field);
  return { control, error };
}

function newServerId() {
  let id;
  do {
    serverIdSequence += 1;
    id = `server-${new Date().getTime()}-${serverIdSequence}`;
  } while (state.servers.some((server) => server.id === id));
  return id;
}

function buildServerForm(server) {
  const form = makeElement("form", "server-form");
  form.id = "serverForm";
  const fields = {};
  fields.name = createField(form, "Server name", "name", { placeholder: "Netherlands" });
  fields.location = createField(form, "Location", "location", { placeholder: "Amsterdam" });
  fields.flag = createField(form, "Flag", "flag", { placeholder: "🇳🇱" });
  fields.address = createField(form, "Address", "address", { placeholder: "example.com" });
  fields.port = createField(form, "Port", "port", { type: "number", min: "1", max: "65535", step: "1" });
  fields.protocol = createField(form, "Protocol", "protocol", { select: protocols });
  fields.ping = createField(form, "Ping (optional)", "ping", { type: "number", min: "0", step: "any" });
  fields.description = createField(form, "Description (optional)", "description", { textarea: true, wide: true });
  form.appendChild(makeElement("div", "modal-feedback", ""));

  if (server) {
    Object.keys(fields).forEach((key) => {
      const value = server[key];
      fields[key].control.value = value === null || typeof value === "undefined" ? "" : String(value);
    });
  } else {
    fields.port.control.value = "443";
    fields.protocol.control.value = "HTTPS";
  }

  return { form, fields };
}

function readAndValidateServer(fields) {
  let valid = true;
  const values = {};

  Object.keys(fields).forEach((key) => {
    fields[key].error.textContent = "";
  });

  values.name = fields.name.control.value.trim();
  values.location = fields.location.control.value.trim();
  values.flag = fields.flag.control.value.trim();
  values.address = fields.address.control.value.trim();
  values.port = Number(fields.port.control.value);
  values.protocol = fields.protocol.control.value;
  values.ping = fields.ping.control.value.trim() === "" ? null : Number(fields.ping.control.value);
  values.description = fields.description.control.value.trim();

  if (!values.name) {
    fields.name.error.textContent = "Enter a server name.";
    valid = false;
  }
  if (!values.location) {
    fields.location.error.textContent = "Enter a location.";
    valid = false;
  }
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) {
    fields.port.error.textContent = "Port must be a number from 1 to 65535.";
    valid = false;
  }
  if (protocols.indexOf(values.protocol) === -1) {
    fields.protocol.error.textContent = "Choose a supported protocol.";
    valid = false;
  }
  if (values.ping !== null && (!Number.isFinite(values.ping) || values.ping < 0)) {
    fields.ping.error.textContent = "Ping must be zero or a positive number.";
    valid = false;
  }
  if (!values.name && !values.location && !values.address && !fields.port.control.value.trim()) {
    fields.name.error.textContent = "Enter server details before saving.";
    valid = false;
  }

  return valid ? values : null;
}

function openServerEditor(server) {
  showServerForm("Edit server", server);
}

function showServerForm(title, server) {
  const built = buildServerForm(server);
  const form = built.form;
  const fields = built.fields;
  const cancel = makeButton("Cancel", "secondary-button", closeModal);
  const save = makeButton(server ? "Save changes" : "Add server", "primary-button", () => {});
  save.type = "submit";
  save.setAttribute("form", form.id);
  const actions = [];
  let deleteButton;

  if (server) {
    deleteButton = makeButton("Delete server", "danger-button", () => showDeleteConfirmation(server, form, actions));
    actions.push(deleteButton);
  }
  actions.push(cancel, save);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = readAndValidateServer(fields);
    if (!values) return;

    const nextServer = Object.assign({}, values, { id: server ? server.id : newServerId() });
    const previousState = copyConfig(state);
    if (server) {
      state.servers = state.servers.map((item) => item.id === server.id ? nextServer : item);
    } else {
      state.servers = state.servers.concat([nextServer]);
      if (!connected) state.selectedServerId = nextServer.id;
    }

    try {
      await persistConfig();
      closeModal();
      renderServers();
      updateConnectionView();
      notify(server ? "Server changes saved" : "Server added");
    } catch (error) {
      state = previousState;
      renderServers();
      setModalFeedback(`Could not save server: ${error.message}`, true);
    }
  });

  showModal(title, form, actions);
}

function showDeleteConfirmation(server, form, editorActions) {
  const confirmation = makeElement("div", "delete-confirmation");
  confirmation.appendChild(makeElement("p", "", "Are you sure you want to remove this server?"));
  const feedback = makeElement("div", "modal-feedback", "");
  confirmation.appendChild(feedback);

  const cancel = makeButton("Cancel", "secondary-button", () => {
    modalTitle.textContent = "Edit server";
    modalContent.textContent = "";
    modalContent.appendChild(form);
    modalActions.textContent = "";
    editorActions.forEach((action) => modalActions.appendChild(action));
    form.querySelector("input").focus();
  });
  const remove = makeButton("Delete", "danger-button", async () => {
    if (state.servers.length <= 1) {
      feedback.textContent = "At least one server must remain.";
      feedback.classList.add("error");
      return;
    }

    const previousState = copyConfig(state);
    state.servers = state.servers.filter((item) => item.id !== server.id);
    if (state.selectedServerId === server.id) state.selectedServerId = state.servers[0].id;

    try {
      await persistConfig();
      closeModal();
      renderServers();
      updateConnectionView();
      notify("Server deleted");
    } catch (error) {
      state = previousState;
      renderServers();
      feedback.textContent = `Could not delete server: ${error.message}`;
      feedback.classList.add("error");
    }
  });

  modalTitle.textContent = "Delete server?";
  modalContent.textContent = "";
  modalContent.appendChild(confirmation);
  modalActions.textContent = "";
  modalActions.appendChild(cancel);
  modalActions.appendChild(remove);
}

async function importServers() {
  try {
    const imported = await window.ChoobsStorage.importServers();
    if (!imported) return;
    const previousState = copyConfig(state);
    state = SubscriptionManager.importData(imported, state);
    try {
      await persistConfig();
    } catch (error) {
      state = previousState;
      throw error;
    }

    renderServers();
    updateConnectionView();
    const addedCount = state.servers.length - previousState.servers.length;
    if (!modalOverlay.hidden || modalTitle.textContent === "Settings") openSettings();
    setModalFeedback(`Imported ${addedCount} server${addedCount === 1 ? "" : "s"} and subscriptions.`, false);
    notify(`Imported ${addedCount} server${addedCount === 1 ? "" : "s"}`);
  } catch (error) {
    setModalFeedback(error.message, true);
    notify(`Import failed: ${error.message}`);
  }
}

async function exportServers() {
  try {
    const exported = await window.ChoobsStorage.exportServers({
      subscriptions: state.subscriptions,
      servers: state.servers,
      selectedServerId: state.selectedServerId,
      favorites: state.favorites,
      settings: state.settings
    });
    if (exported) {
      setModalFeedback("Servers exported successfully.", false);
      notify("Servers exported");
    }
  } catch (error) {
    setModalFeedback(error.message, true);
    notify(`Export failed: ${error.message}`);
  }
}

settingsButton.addEventListener("click", openSettings);
addSubscriptionButton.addEventListener("click", openAddSubscription);
refreshSubscriptionsButton.addEventListener("click", refreshAllSubscriptions);
bestServerButton.addEventListener("click", chooseBestServer);
modalClose.addEventListener("click", closeModal);

modalOverlay.addEventListener("click", (event) => {
  if (event.target === modalOverlay) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalOverlay.hidden) closeModal();
});

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function coreStartError(result) {
  const message = result && result.error ? result.error : "VPN core did not start.";
  if (/core manager executable not found/i.test(message)) {
    return new Error("Core Manager не найден — соберите backend/choobs-core-manager.");
  }
  if (/VPN core not found|sing-box executable not found|no such file/i.test(message)) {
    return new Error("VPN core не найден — установите sing-box core.");
  }
  return new Error(message);
}

async function connectToServer(server, retryOnce) {
  if (connectionPending || !server || !transitionConnection("CONNECT")) return false;
  connectionFailure = "";
  connectionServerId = server.id;
  renderServers();
  updateConnectionView();
  const start = async () => {
    if (window.ChoobsStorage.isPreview) {
      await wait(650);
      return { running: true, state: "running", demo: true };
    }
    const result = await window.choobs.startCore(server.id);
    if (result && result.running && result.code === "PROXY_RESTORE_FAILED") return result;
    if (!result || result.state !== "running" || !result.running) throw coreStartError(result);
    return result;
  };

  try {
    const result = retryOnce
      ? await window.ChoobsUIState.connectWithOneRetry(start, wait)
      : await start();
    if (connectionState === "connecting") transitionConnection("CONNECTED");
    if (!connectionStartedAt) setConnectionStarted(server);
    if (result.error) connectionFailure = "Proxy restore needs attention";
    if (window.ChoobsStorage.isPreview) notify(`Demo connected to ${server.location || server.name}`);
    else {
      notify(result.error ? result.error : "Connected");
      monitorCoreStatus();
    }
    return true;
  } catch (error) {
    if (connectionState === "connecting") transitionConnection("CONNECT_FAILED");
    connectionFailure = error.message;
    stopConnectionDuration();
    connectionServerId = null;
    notify(`Connection failed: ${error.message}`);
    return false;
  } finally {
    renderServers();
    updateConnectionView();
  }
}

async function disconnect() {
  if (connectionPending || !connected || !transitionConnection("DISCONNECT")) return false;
  renderServers();
  updateConnectionView();
  try {
    if (window.ChoobsStorage.isPreview) {
      await wait(400);
    } else {
      const result = await window.choobs.stopCore();
      if (!result || result.state !== "stopped" || result.running || result.code === "PROXY_RESTORE_FAILED") {
        throw new Error(result && result.error ? result.error : "Could not safely disconnect.");
      }
    }
    transitionConnection("DISCONNECTED");
    connectionFailure = "";
    stopConnectionDuration();
    notify("Disconnected; previous Windows proxy settings restored");
    if (coreStatusTimer) window.clearInterval(coreStatusTimer);
    coreStatusTimer = null;
    return true;
  } catch (error) {
    if (connectionState === "disconnecting") transitionConnection("DISCONNECT_FAILED");
    connectionFailure = error.message;
    notify(`Disconnect failed: ${error.message}`);
    return false;
  } finally {
    renderServers();
    updateConnectionView();
  }
}

connectButton.addEventListener("click", async () => {
  if (connectionPending) return;
  if (connected) {
    await disconnect();
    return;
  }
  const server = selectedServer();
  if (!server) {
    notify("Add a subscription before connecting");
    return;
  }
  await connectToServer(server, false);
});

if (!window.ChoobsStorage.isPreview && window.choobs && typeof window.choobs.onCoreStatus === "function") {
  window.choobs.onCoreStatus(syncConnectionFromCore);
}

async function start() {
  try {
    const result = await window.ChoobsStorage.loadConfig();
    state = result.config;
    if (!Array.isArray(state.subscriptions)) state.subscriptions = [];
    if (!Array.isArray(state.favorites)) state.favorites = [];
    state.settings = Object.assign(defaultSettings(), state.settings || {});
    renderServers();
    updateConnectionView();
    if (result.warning) notify(result.warning);
    else if (window.ChoobsStorage.isPreview) notify("Browser preview · demo connection only");
    if (!window.ChoobsStorage.isPreview && window.choobs && typeof window.choobs.getCoreStatus === "function") {
      try {
        const coreStatus = await window.choobs.getCoreStatus();
        syncConnectionFromCore(coreStatus);
      } catch (error) {
        notify(`Could not read VPN core status: ${error.message}`);
      }
    }
    if (!window.ChoobsStorage.isPreview && state.settings.startWithWindows) {
      try {
        await window.ChoobsStorage.setStartWithWindows(true);
      } catch (error) {
        notify("Could not register Choobs to start with Windows");
      }
    }
    const startupPlan = window.ChoobsUIState.startupPlan(
      state.settings,
      Boolean(selectedServer()),
      state.servers.length > 0
    );
    if (!window.ChoobsStorage.isPreview && startupPlan !== "disabled" && !connected) {
      let server = startupPlan === "saved" ? selectedServer() : null;
      if (!server && startupPlan === "best") {
        try {
          pingSweepRunning = true;
          renderServers();
          const best = await measureBestServer(state.servers.slice());
          if (best) {
            server = best.server;
            state.selectedServerId = server.id;
            await persistConfig();
          }
        } catch (error) {
          notify(`Could not find a server for auto-connect: ${error.message}`);
        } finally {
          pingSweepRunning = false;
          renderServers();
        }
      }
      if (server) await connectToServer(server, true);
      else if (startupPlan === "unavailable") notify("Auto-connect skipped because no saved server is available");
    }
  } catch (error) {
    state = {
      servers: [],
      subscriptions: [],
      favorites: [],
      selectedServerId: null,
      settings: defaultSettings()
    };
    renderServers();
    updateConnectionView();
    notify(`Could not load saved configuration: ${error.message}`);
  }
}

start();
