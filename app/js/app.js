const serverList = document.getElementById("serverList");
const serverCount = document.getElementById("serverCount");
const selectedServerLabel = document.getElementById("selectedServer");
const connectButton = document.getElementById("connectButton");
const connectionOrbit = document.querySelector(".connection-orbit");
const status = document.getElementById("status");
const settingsButton = document.getElementById("settingsButton");
const addServerButton = document.getElementById("addServer");
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
    connectOnStart: false
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
  return state.servers.find((server) => server.id === state.selectedServerId) || state.servers[0];
}

function updateConnectionView() {
  if (connectionPending) {
    connectButton.textContent = pendingTarget ? "CONNECTING…" : "DISCONNECTING…";
  } else {
    connectButton.textContent = connected ? "DISCONNECT" : "CONNECT";
  }
  connectButton.disabled = connectionPending;
  connectButton.classList.toggle("connected", connected);
  connectButton.setAttribute("aria-pressed", String(connected));
  connectionOrbit.classList.toggle("connected", connected);
  connectionOrbit.classList.toggle("connecting", connectionPending);
  status.textContent = connectionPending
    ? (pendingTarget ? "Connecting…" : "Disconnecting…")
    : (connected ? `Connected • ${selectedServer().location}` : "Not connected");
}

function renderServers() {
  serverList.textContent = "";
  serverCount.textContent = String(state.servers.length);
  const currentServer = selectedServer();
  selectedServerLabel.textContent = `${currentServer.name} · ${currentServer.location}`;

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
    row.appendChild(edit);
    serverList.appendChild(row);
  });
}

function persistConfig() {
  return window.ChoobsStorage.saveConfig(state);
}

function copyConfig(config) {
  return {
    servers: config.servers.map((server) => Object.assign({}, server)),
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
  general.appendChild(makeElement("p", "settings-note", "System startup and tray actions are available in the desktop app."));

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

  const about = addSettingsGroup(content, "ABOUT");
  const aboutCard = makeElement("div", "about-card");
  aboutCard.appendChild(makeElement("strong", "", "Choobs"));
  aboutCard.appendChild(makeElement("span", "", "Version 0.1.0"));
  aboutCard.appendChild(makeElement("span", "", "VPN client for Windows"));
  about.appendChild(aboutCard);

  const dataActions = makeElement("div", "data-actions");
  dataActions.appendChild(makeButton("Import servers", "secondary-button", importServers));
  dataActions.appendChild(makeButton("Export servers", "secondary-button", exportServers));
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

function normalizeImportedServer(server, index) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error(`Server ${index + 1} is not a valid object.`);
  }

  const normalized = {
    id: newServerId(),
    name: typeof server.name === "string" ? server.name.trim() : "",
    location: typeof server.location === "string" ? server.location.trim() : "",
    flag: typeof server.flag === "string" ? server.flag.trim() : "",
    address: typeof server.address === "string" ? server.address.trim() : "",
    port: typeof server.port === "undefined" ? 443 : Number(server.port),
    protocol: server.protocol || "HTTPS",
    ping: server.ping === "" || server.ping === null || typeof server.ping === "undefined"
      ? null
      : Number(server.ping),
    description: typeof server.description === "string" ? server.description.trim() : ""
  };

  if (!normalized.name || !normalized.location) throw new Error(`Server ${index + 1} needs a name and location.`);
  if (!Number.isInteger(normalized.port) || normalized.port < 1 || normalized.port > 65535) {
    throw new Error(`Server ${index + 1} has an invalid port.`);
  }
  if (protocols.indexOf(normalized.protocol) === -1) throw new Error(`Server ${index + 1} has an unsupported protocol.`);
  if (normalized.ping !== null && (!Number.isFinite(normalized.ping) || normalized.ping < 0)) {
    throw new Error(`Server ${index + 1} has an invalid ping.`);
  }
  if (typeof server.address !== "undefined" && typeof server.address !== "string") {
    throw new Error(`Server ${index + 1} has an invalid address.`);
  }
  if (typeof server.description !== "undefined" && typeof server.description !== "string") {
    throw new Error(`Server ${index + 1} has an invalid description.`);
  }
  return normalized;
}

async function importServers() {
  try {
    const imported = await window.ChoobsStorage.importServers();
    if (!imported) return;

    const entries = Array.isArray(imported) ? imported : imported.servers;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("The JSON file must contain a non-empty servers array.");
    }

    const addedServers = entries.map(normalizeImportedServer);
    state.servers = state.servers.concat(addedServers);
    try {
      await persistConfig();
    } catch (error) {
      state.servers = state.servers.slice(0, state.servers.length - addedServers.length);
      throw error;
    }

    renderServers();
    setModalFeedback(`Imported ${addedServers.length} server${addedServers.length === 1 ? "" : "s"}.`, false);
    notify(`Imported ${addedServers.length} server${addedServers.length === 1 ? "" : "s"}`);
  } catch (error) {
    setModalFeedback(error.message, true);
    notify(`Import failed: ${error.message}`);
  }
}

async function exportServers() {
  try {
    const exported = await window.ChoobsStorage.exportServers(state.servers);
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
addServerButton.addEventListener("click", () => showServerForm("Add server", null));
modalClose.addEventListener("click", closeModal);

modalOverlay.addEventListener("click", (event) => {
  if (event.target === modalOverlay) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalOverlay.hidden) closeModal();
});

connectButton.addEventListener("click", () => {
  if (connectionPending) return;
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
    renderServers();
    updateConnectionView();
    if (result.warning) notify(result.warning);
    else if (window.ChoobsStorage.isPreview) notify("Browser preview · demo connection only");
  } catch (error) {
    state = {
      servers: servers.map((server) => Object.assign({}, server)),
      selectedServerId: servers[0].id,
      settings: defaultSettings()
    };
    renderServers();
    updateConnectionView();
    notify(`Could not load saved configuration: ${error.message}`);
  }
}

start();
