const serverList = document.getElementById("serverList");
const serverCount = document.getElementById("serverCount");
const selectedServerLabel = document.getElementById("selectedServer");
const connectButton = document.getElementById("connectButton");
const connectionOrbit = document.querySelector(".connection-orbit");
const status = document.getElementById("status");
const settingsButton = document.getElementById("settingsButton");
const addSubscriptionButton = document.getElementById("addSubscription");
const refreshSubscriptionsButton = document.getElementById("refreshSubscriptions");
const checkPingsButton = document.getElementById("checkPings");
const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalContent = document.getElementById("modalContent");
const modalActions = document.getElementById("modalActions");
const modalClose = document.getElementById("modalClose");
const toast = document.getElementById("toast");

const protocols = ["HTTPS", "SOCKS5", "VLESS", "VMess", "Trojan", "Shadowsocks", "Custom"];
const connectionModes = ["System Proxy", "TUN", "Auto"];
let state;
let connected = false;
let connectionPending = false;
let pendingTarget = false;
let modalReturnFocus = null;
let serverIdSequence = 0;
let toastTimer = null;

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
    minimizeToTray: false,
    connectionMode: "System Proxy",
    rememberSelectedServer: true,
    connectOnStart: false,
    autoUpdateSubscriptions: false,
    subscriptionUpdateInterval: "manual"
  };
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
  return state.servers.find((server) => server.id === state.selectedServerId) || state.servers[0] || null;
}

function updateConnectionView() {
  const currentServer = selectedServer();
  if (connectionPending) {
    connectButton.textContent = pendingTarget ? "CONNECTING…" : "DISCONNECTING…";
  } else {
    connectButton.textContent = connected ? "DISCONNECT" : "CONNECT";
  }
  connectButton.disabled = connectionPending || (!connected && !currentServer);
  connectButton.classList.toggle("connected", connected);
  connectButton.setAttribute("aria-pressed", String(connected));
  connectionOrbit.classList.toggle("connected", connected);
  connectionOrbit.classList.toggle("connecting", connectionPending);
  status.textContent = connectionPending
    ? (pendingTarget ? "Connecting…" : "Disconnecting…")
    : (connected && currentServer ? `Connected • ${currentServer.location}` : "Not connected");
}

function renderServers() {
  serverList.textContent = "";
  serverCount.textContent = String(state.servers.length);
  refreshSubscriptionsButton.disabled = state.subscriptions.length === 0 || connectionPending;
  checkPingsButton.disabled = state.servers.length === 0 || connectionPending;
  const currentServer = selectedServer();
  addSubscriptionButton.disabled = connected || connectionPending;
  selectedServerLabel.textContent = currentServer
    ? `${currentServer.flag || "🌐"} ${currentServer.name} · ${currentServer.location}`
    : "No server selected";

  if (state.servers.length === 0) {
    const empty = makeElement("div", "empty-servers");
    empty.appendChild(makeElement("strong", "", "Add a VPN subscription"));
    empty.appendChild(makeElement("span", "", "Your server locations will appear here after the subscription is loaded."));
    serverList.appendChild(empty);
    return;
  }

  state.servers.forEach((server) => {
    const row = makeElement("div", "server-entry");
    const button = makeElement("button", "server-card");
    const flag = makeElement("span", "server-flag", server.flag || "🌐");
    const info = makeElement("span", "server-info");
    const name = makeElement("span", "server-name", server.name);
    const location = makeElement("span", "server-location", server.location);
    const ping = makeElement("span", "server-ping", server.ping === null ? "—" : `${server.ping} ms`);
    const arrow = makeElement("span", "server-arrow", "›");
    const edit = makeButton("⋯", "server-edit", () => openServerEditor(server));

    button.type = "button";
    button.setAttribute("aria-label", `${server.name}, ${server.location}, ${server.ping === null ? "ping unavailable" : `${server.ping} ms`}`);
    button.disabled = connected || connectionPending;
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
    edit.setAttribute("aria-label", `Edit ${server.name}`);
    edit.title = "Edit server";
    edit.disabled = connected || connectionPending;

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
  const general = addSettingsGroup(content, "GENERAL");
  addSettingsCheckbox(general, "startWithWindows", "Start with Windows");
  addSettingsCheckbox(general, "autoConnect", "Auto connect");
  addSettingsCheckbox(general, "minimizeToTray", "Minimize to tray");
  addSettingsCheckbox(general, "autoUpdateSubscriptions", "Update subscriptions automatically");
  const intervalLabel = makeElement("label", "setting-select-row");
  intervalLabel.appendChild(makeElement("span", "", "Update interval"));
  const intervalSelect = makeElement("select", "setting-select");
  intervalSelect.setAttribute("data-setting", "subscriptionUpdateInterval");
  [
    ["15m", "15 minutes"],
    ["30m", "30 minutes"],
    ["1h", "1 hour"],
    ["6h", "6 hours"],
    ["12h", "12 hours"],
    ["24h", "24 hours"],
    ["manual", "Manually"]
  ].forEach(([value, label]) => {
    const option = makeElement("option", "", label);
    option.value = value;
    option.selected = value === state.settings.subscriptionUpdateInterval;
    intervalSelect.appendChild(option);
  });
  intervalLabel.appendChild(intervalSelect);
  general.appendChild(intervalLabel);
  general.appendChild(makeElement("p", "settings-note", "Automatic refresh is a saved preference; subscriptions currently refresh when requested."));

  const connection = addSettingsGroup(content, "CONNECTION");
  const modeLabel = makeElement("label", "setting-select-row");
  modeLabel.appendChild(makeElement("span", "", "Connection mode"));
  const modeSelect = makeElement("select", "setting-select");
  modeSelect.setAttribute("data-setting", "connectionMode");
  connectionModes.forEach((mode) => {
    const option = makeElement("option", "", mode);
    option.value = mode;
    option.selected = mode === state.settings.connectionMode;
    modeSelect.appendChild(option);
  });
  modeLabel.appendChild(modeSelect);
  connection.appendChild(modeLabel);

  const behavior = addSettingsGroup(content, "BEHAVIOR");
  addSettingsCheckbox(behavior, "rememberSelectedServer", "Remember selected server");
  addSettingsCheckbox(behavior, "connectOnStart", "Connect on application start");

  const subscriptions = addSettingsGroup(content, "SUBSCRIPTIONS");
  if (state.subscriptions.length === 0) {
    subscriptions.appendChild(makeElement("p", "subscription-empty", "No subscriptions added yet."));
  } else {
    state.subscriptions.forEach((subscription) => {
      const card = makeElement("div", "subscription-card");
      const summary = makeElement("div", "subscription-summary");
      summary.appendChild(makeElement("strong", "", subscription.name));
      summary.appendChild(makeElement("span", "subscription-url", SubscriptionManager.displayUrl(subscription.url)));
      summary.appendChild(makeElement("span", "subscription-updated", `Updated: ${formatUpdatedAt(subscription.updatedAt)}`));
      card.appendChild(summary);
      const controls = makeElement("div", "subscription-controls");
      const refresh = makeButton("Refresh", "secondary-button", () => refreshSubscription(subscription.id));
      const remove = makeButton("Remove", "danger-button", () => confirmRemoveSubscription(subscription));
      refresh.disabled = connected || connectionPending;
      remove.disabled = connected || connectionPending;
      controls.appendChild(refresh);
      controls.appendChild(remove);
      card.appendChild(controls);
      subscriptions.appendChild(card);
    });
  }
  subscriptions.appendChild(makeButton("Add subscription", "secondary-button", openAddSubscription));

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
    content.querySelectorAll("[data-setting]").forEach((control) => {
      const key = control.getAttribute("data-setting");
      state.settings[key] = control.type === "checkbox" ? control.checked : control.value;
    });

    try {
      await persistConfig();
      closeModal();
      notify("Settings saved");
    } catch (error) {
      state.settings = previousSettings;
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
  const nameField = createField(form, "Subscription name", "subscription-name", { placeholder: "My VPN" });
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
    if (!name) {
      nameField.error.textContent = "Enter a subscription name.";
      return;
    }
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
  if (connected || connectionPending) {
    notify("Disconnect before updating subscriptions");
    return false;
  }
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
    if (!modalOverlay.hidden && modalTitle.textContent === "Settings") openSettings();
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
  refreshSubscriptionsButton.disabled = true;
  refreshSubscriptionsButton.textContent = "↻ Updating…";
  let successes = 0;
  for (let index = 0; index < state.subscriptions.length; index += 1) {
    if (await refreshSubscription(state.subscriptions[index].id)) successes += 1;
  }
  refreshSubscriptionsButton.textContent = "↻ Refresh subscription";
  refreshSubscriptionsButton.disabled = state.subscriptions.length === 0;
  if (successes === state.subscriptions.length) notify("All subscriptions updated");
  else if (successes) notify(`${successes} of ${state.subscriptions.length} subscriptions updated`);
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

async function checkServerPings() {
  if (window.ChoobsStorage.isPreview) {
    notify("Ping checks require the desktop app; no mock values are shown");
    return;
  }
  checkPingsButton.disabled = true;
  checkPingsButton.textContent = "◉ Checking…";
  let failed = 0;
  for (let index = 0; index < state.servers.length; index += 1) {
    const server = state.servers[index];
    try {
      const result = await window.ChoobsStorage.pingServer(server);
      server.ping = result && Number.isFinite(result.ping) ? result.ping : null;
      if (server.ping === null) failed += 1;
    } catch (error) {
      server.ping = null;
      failed += 1;
    }
    renderServers();
    checkPingsButton.disabled = true;
    checkPingsButton.textContent = "◉ Checking…";
  }
  checkPingsButton.textContent = "◉ Check ping";
  checkPingsButton.disabled = state.servers.length === 0;
  persistConfig().catch((error) => notify(`Could not save ping results: ${error.message}`));
  notify(failed ? `Ping check complete — ${failed} unavailable` : "Ping check complete");
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
checkPingsButton.addEventListener("click", checkServerPings);
modalClose.addEventListener("click", closeModal);

modalOverlay.addEventListener("click", (event) => {
  if (event.target === modalOverlay) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalOverlay.hidden) closeModal();
});

connectButton.addEventListener("click", () => {
  if (connectionPending) return;
  if (!connected && !selectedServer()) {
    notify("Add a subscription before connecting");
    return;
  }
  pendingTarget = !connected;
  connectionPending = true;
  renderServers();
  updateConnectionView();
  window.setTimeout(() => {
    connected = pendingTarget;
    connectionPending = false;
    renderServers();
    updateConnectionView();
    notify(connected ? `Demo connected to ${selectedServer().location}` : "Demo disconnected");
  }, 650);
});

async function start() {
  try {
    const result = await window.ChoobsStorage.loadConfig();
    state = result.config;
    if (!Array.isArray(state.subscriptions)) state.subscriptions = [];
    state.settings = Object.assign(defaultSettings(), state.settings || {});
    renderServers();
    updateConnectionView();
    if (result.warning) notify(result.warning);
    else if (window.ChoobsStorage.isPreview) notify("Browser preview · demo connection only");
  } catch (error) {
    state = {
      servers: [],
      subscriptions: [],
      selectedServerId: null,
      settings: defaultSettings()
    };
    renderServers();
    updateConnectionView();
    notify(`Could not load saved configuration: ${error.message}`);
  }
}

start();
