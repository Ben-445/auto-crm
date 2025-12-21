const {
  app,
  globalShortcut,
  BrowserWindow,
  screen,
  ipcMain,
  systemPreferences,
  shell,
  nativeImage,
  Tray,
  Menu,
  Notification,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const log = require("electron-log");
const ElectronStore = require("electron-store");
const Screenshots = require("./screenshots");
const crypto = require("crypto");

let mainWindow;
let overlayWindow;
let settingsWindow = null;
let tray = null;
let updateDownloaded = false;
let downloadedUpdateVersion = null;
let updatePromptWindow = null;
let updateCountdownTimer = null;
let updateCountdownEndsAt = null;
let updateSnoozedUntil = null;
let updateDeferredInstall = false;
let overlayActive = false;
let quotaPromptWindow = null;
let lastQuotaPromptPayload = null;
const screenshots = new Screenshots();

// Single-instance lock: prevent multiple tray icons / processes.
// If a second launch happens, focus the existing instance and open Settings.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    try {
      // Close capture overlay if it somehow exists and focus settings instead.
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.close();
      }
      openSettingsWindow();
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        if (settingsWindow.isMinimized()) settingsWindow.restore();
        settingsWindow.show();
        settingsWindow.focus();
      }
    } catch (e) {
      // ignore
    }
  });
}

// Windows: help the OS associate our running process/window with the correct app identity/icon.
// This improves taskbar/Alt-Tab icon consistency across updates.
if (process.platform === "win32") {
  try {
    app.setAppUserModelId("com.micro.screenshotcrm");
  } catch (e) {
    // ignore
  }
}

const DEFAULT_SHORTCUT =
  process.platform === "darwin" ? "Command+Shift+S" : "Control+Shift+S";
const DEFAULT_API_BASE_URL =
  "https://ukjfvashhxcovonpweye.supabase.co/functions/v1";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const UPDATE_MIN_CHECK_GAP_MS = 30 * 60 * 1000; // 30m
const UPDATE_AUTO_RESTART_DELAY_MS = 5 * 60 * 1000; // 5m
// electron-store can export either the constructor directly (CJS) or under `.default` (ESM interop).
const Store = ElectronStore?.default ?? ElectronStore;
const store = new Store({
  name: "settings",
  defaults: {
    authToken: "",
    apiBaseUrl: DEFAULT_API_BASE_URL,
    shortcut: DEFAULT_SHORTCUT,
    startOnLogin: true,
    startOnLoginUserSet: false,
    // Privacy: do not persist raw screenshots locally unless explicitly enabled.
    saveScreenshotsLocally: false,
    lastUpdateCheckAt: 0,
    updateSnoozedUntil: 0,
  },
});

app.on("ready", () => {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const appIcon = loadAppIcon();

  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  mainWindow = new BrowserWindow({
    show: false,
    width: width,
    height: height,
    transparent: true,
    frame: false,
    icon: appIcon,
  });

  mainWindow.loadFile("select_area.html");

  if (process.platform === "darwin" && appIcon && app.dock) {
    app.dock.setIcon(appIcon);
  }

  setupTray();
  setupAutoUpdater();
  scheduleUpdateChecks();
  // Default "start on login" to ON unless the user has explicitly changed it.
  if (!Boolean(store.get("startOnLoginUserSet"))) {
    store.set("startOnLogin", true);
  }
  applyStartOnLoginFromStore();
  registerShortcutFromStore();

  // First run: if user hasn't paired yet, open Settings automatically.
  if (!String(store.get("authToken") || "").trim()) {
    openSettingsWindow();
  }

  // (global shortcut registration is now driven by stored settings)
});

function getApiBaseUrl() {
  const raw = String(store.get("apiBaseUrl") || DEFAULT_API_BASE_URL).trim();
  return raw.replace(/\/+$/, "");
}

function getAuthToken() {
  return String(store.get("authToken") || "").trim();
}

function getClientMetadata() {
  return {
    client_os: process.platform,
    client_version: app.getVersion(),
  };
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function verifyDesktopToken(token) {
  const apiBaseUrl = getApiBaseUrl();
  const url = `${apiBaseUrl}/desktop-verify-token`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    12000
  );
  if (res.ok) return { ok: true };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "invalid_token" };
  }
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch (e) {
    // ignore
  }
  return { ok: false, reason: `verify_failed_${res.status}`, details: bodyText };
}

async function uploadScreenshotPng(pngBuffer, bounds) {
  const token = getAuthToken();
  if (!token) {
    notify("Not paired", "Open Settings to add your desktop token.");
    openSettingsWindow();
    return { ok: false, reason: "not_paired" };
  }

  const apiBaseUrl = getApiBaseUrl();
  const url = `${apiBaseUrl}/screenshot-capture`;
  const capturedAtIso = new Date().toISOString();
  const { client_os, client_version } = getClientMetadata();
  const hash = sha256Hex(pngBuffer);

  // FormData/Blob compatibility across Node/Electron versions.
  let FormDataCtor = globalThis.FormData;
  let BlobCtor = globalThis.Blob;
  if (!FormDataCtor || !BlobCtor) {
    try {
      const undici = require("undici");
      FormDataCtor = FormDataCtor || undici.FormData;
      BlobCtor = BlobCtor || undici.Blob;
    } catch (e) {
      // keep as-is
    }
  }
  if (!FormDataCtor || !BlobCtor) {
    throw new Error("FormData/Blob not available in this runtime");
  }

  const form = new FormDataCtor();
  const blob = new BlobCtor([pngBuffer], { type: "image/png" });
  form.append("image", blob, `screenshot_${Date.now()}.png`);
  form.append("captured_at", capturedAtIso);
  form.append("client_os", client_os);
  form.append("client_version", client_version);
  form.append("bounds", JSON.stringify(bounds || null));
  form.append("sha256", hash);

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    },
    20000
  );

  if (res.ok) {
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      // ok
    }
    return { ok: true, response: json };
  }

  // Attempt to parse a structured error response.
  // Use clone() so we can fall back to text even if JSON parsing fails.
  let errorJson = null;
  let errorText = "";
  try {
    errorJson = await res.clone().json();
  } catch (e) {
    // ignore
  }
  try {
    errorText = await res.text();
  } catch (e) {
    // ignore
  }

  // Auth errors: only clear token for explicit invalid auth cases.
  if (res.status === 401) {
    // Token is invalid/revoked. Stop future sends until user re-pairs.
    store.set("authToken", "");
    notify(
      "Token invalid",
      "Your desktop token is invalid. Please re-pair in Settings."
    );
    openSettingsWindow();
    return { ok: false, reason: "invalid_token" };
  }

  // Quota exceeded (HTTP 403): do NOT clear token; prompt upgrade instead.
  if (res.status === 403 && errorJson && errorJson.error === "quota_exceeded") {
    const userMessage =
      String(errorJson.user_message || errorJson.message || "").trim() ||
      "You've reached your monthly limit. Upgrade to continue.";
    const billingUrl =
      String(errorJson.billing_url || errorJson?.action?.url || "").trim() || null;
    const action =
      errorJson?.action && typeof errorJson.action === "object"
        ? {
            type: errorJson.action.type || "open_url",
            url: String(errorJson.action.url || billingUrl || "").trim() || null,
            label: String(errorJson.action.label || "Upgrade to Pro").trim() || "Upgrade to Pro",
          }
        : {
            type: "open_url",
            url: billingUrl,
            label: "Upgrade to Pro",
          };

    return {
      ok: false,
      reason: "quota_exceeded",
      quota: {
        current_count: errorJson.current_count,
        quota: errorJson.quota,
        message: errorJson.message,
        user_message: userMessage,
        billing_url: billingUrl,
        action,
      },
    };
  }

  // Other 403s are treated as generic failures (do not clear token).
  if (res.status === 403) {
    return {
      ok: false,
      reason: "forbidden",
      details: errorJson ? JSON.stringify(errorJson) : errorText,
    };
  }

  return {
    ok: false,
    reason: `upload_failed_${res.status}`,
    details: errorJson ? JSON.stringify(errorJson) : errorText,
  };
}

function canCaptureScreenOrPrompt() {
  if (process.platform !== "darwin") return true;
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted") return true;

  console.log(
    "Screen capture permission not granted. Please enable it in System Preferences."
  );
  shell.openExternal(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenRecording"
  );
  return false;
}

function onShortcutPressed() {
  if (!canCaptureScreenOrPrompt()) return;

  // Only show the overlay window for selection; keep the hidden main window untouched.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  createOverlayWindow();
}

function registerShortcutFromStore() {
  const shortcut = String(store.get("shortcut") || DEFAULT_SHORTCUT).trim();

  try {
    globalShortcut.unregisterAll();
  } catch (e) {
    // ignore
  }

  const ok = globalShortcut.register(shortcut, onShortcutPressed);
  if (!ok) {
    console.warn("Failed to register shortcut:", shortcut);
    // Fallback to default if the saved shortcut is invalid/unavailable.
    if (shortcut !== DEFAULT_SHORTCUT) {
      store.set("shortcut", DEFAULT_SHORTCUT);
      globalShortcut.register(DEFAULT_SHORTCUT, onShortcutPressed);
    }
  }
}

function applyStartOnLoginFromStore() {
  const openAtLogin = Boolean(store.get("startOnLogin"));
  try {
    app.setLoginItemSettings({
      openAtLogin,
    });
  } catch (e) {
    console.warn("Failed to apply start-on-login setting:", e);
  }
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  overlayActive = true;
  overlayWindow = new BrowserWindow({
    width,
    height,
    frame: false,
    transparent: true,
    fullscreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    movable: false,
    resizable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.loadFile("select_area.html");

  overlayWindow.on("closed", () => {
    overlayWindow = null;
    overlayActive = false;
    if (updateDeferredInstall && updateDownloaded) {
      updateDeferredInstall = false;
      try {
        autoUpdater.quitAndInstall();
      } catch (e) {
        // ignore
      }
    }
    // Ensure the background window stays hidden so the cursor resets to the previous app.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  });

  overlayWindow.webContents.on("did-finish-load", () => {
    overlayWindow.webContents.send("window-loaded");
  });
}

function openSettingsWindow() {
  const appIcon = loadAppIcon();

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 760,
    minHeight: 600,
    title: "Send to CRM — Settings",
    icon: appIcon,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  settingsWindow.loadFile("settings.html");
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function setupTray() {
  const icon = loadTrayIcon();
  if (!icon) {
    console.warn("Tray icon not available; tray will not be created.");
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip(`Send to CRM (${app.getVersion()})`);
  tray.setContextMenu(buildTrayMenu());

  // UX: left-click opens Settings, right-click opens the menu.
  tray.on("click", () => openSettingsWindow());
  tray.on("right-click", () => tray.popUpContextMenu());
}

function buildTrayMenu() {
  const version = app.getVersion();
  const restartLabel = downloadedUpdateVersion
    ? `Restart to update (${downloadedUpdateVersion})`
    : "Restart to apply update";
  const snoozedUntil = Number(store.get("updateSnoozedUntil") || 0);
  const snoozed = updateDownloaded && snoozedUntil && Date.now() < snoozedUntil;
  const snoozeLabel = snoozed
    ? `Update snoozed (${minutesFromNow(snoozedUntil)}m)`
    : "Snooze update…";

  return Menu.buildFromTemplate([
    {
      label: `Send to CRM — v${version}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Open Settings",
      click: () => openSettingsWindow(),
    },
    {
      label: "Check for updates",
      click: async () => {
        try {
          // Manual checks should ignore snooze.
          await checkForUpdatesIfAllowed({ ignoreSnooze: true, force: true });
        } catch (e) {
          console.error("Manual update check failed:", e);
          log.error("Manual update check failed:", e);
          notify(
            "Update check failed",
            `Couldn’t check for updates: ${String(e?.message || e)}`
          );
        }
      },
    },
    {
      label: restartLabel,
      enabled: updateDownloaded,
      click: () => autoUpdater.quitAndInstall(),
    },
    {
      label: snoozeLabel,
      enabled: updateDownloaded,
      submenu: [
        {
          label: "Snooze 15 minutes",
          enabled: updateDownloaded,
          click: () => snoozeUpdate(15),
        },
        {
          label: "Snooze 1 hour",
          enabled: updateDownloaded,
          click: () => snoozeUpdate(60),
        },
        {
          label: "Show restart prompt",
          enabled: updateDownloaded,
          click: () => openUpdatePromptWindow(),
        },
      ],
    },
    {
      label: "Open logs",
      click: () => {
        try {
          const logFilePath = log.transports.file.getFile().path;
          shell.showItemInFolder(logFilePath);
        } catch (e) {
          console.error("Failed to open logs:", e);
        }
      },
    },
    {
      label: "Open downloads page",
      click: () => shell.openExternal("https://github.com/Ben-445/auto-crm/releases/latest"),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`Send to CRM (${app.getVersion()})`);
  tray.setContextMenu(buildTrayMenu());
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch (e) {
    // Notification support varies by OS and environment; logs are sufficient.
  }
}

function loadAppIcon() {
  const candidateFiles = [
    process.platform === "win32" ? "icon.ico" : null,
    process.platform === "darwin" ? "icon.icns" : null,
    "icon.png",
  ].filter(Boolean);

  const baseCandidates = [
    __dirname,
    // Packaged app: app.getAppPath() points to .../resources/app.asar
    app.getAppPath ? app.getAppPath() : null,
    // Some environments resolve assets relative to the resources folder.
    process.resourcesPath || null,
  ].filter(Boolean);

  for (const file of candidateFiles) {
    for (const base of baseCandidates) {
      const iconPath = path.join(base, "assets", "icons", file);
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) {
        return image;
      }
    }
  }

  console.warn("App icon not found in assets/icons; using default Electron icon.");
  return undefined;
}

function loadTrayIcon() {
  const baseIcon = loadAppIcon();
  if (!baseIcon || baseIcon.isEmpty()) return null;

  if (process.platform === "win32") {
    return baseIcon.resize({ width: 16, height: 16 });
  }

  return baseIcon;
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log("Auto-update disabled in development mode.");
    return;
  }

  // Persist auto-update logs to disk so packaged builds are debuggable.
  log.transports.file.level = "info";
  autoUpdater.logger = log;

  autoUpdater.autoDownload = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("Checking for updates...");
    log.info("Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("Update available:", info?.version || "unknown version");
    log.info("Update available:", info?.version || "unknown version");
    notify("Update available", `Downloading version ${info?.version || ""}`.trim());
  });

  autoUpdater.on("update-not-available", () => {
    console.log("No updates available.");
    log.info("No updates available.");
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(
      `Download speed: ${Math.round(progress.bytesPerSecond / 1024)} KB/s, ` +
        `Downloaded ${Math.round(progress.percent)}%`
    );
    log.info(
      "Download progress",
      Math.round(progress.percent),
      "bytesPerSecond",
      progress.bytesPerSecond
    );
  });

  autoUpdater.on("update-downloaded", (info) => {
    downloadedUpdateVersion = info?.version || null;
    updateDownloaded = true;
    console.log("Update downloaded; ready to install.", downloadedUpdateVersion);
    log.info("Update downloaded; ready to install.", downloadedUpdateVersion);
    store.set("updateSnoozedUntil", 0);
    refreshTrayMenu();
    notify(
      "Update ready",
      downloadedUpdateVersion
        ? `Version ${downloadedUpdateVersion} is ready. Restart to apply.`
        : "An update is ready. Restart to apply."
    );
    // Start (or restart) the restart prompt + countdown.
    startUpdateCountdownIfAllowed();
    openUpdatePromptWindow();
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err);
    log.error("Auto-update error:", err);
    refreshTrayMenu();
    notify("Update error", `Update failed: ${String(err?.message || err)}`);
  });

  // Startup check (but avoid hammering if the app is restarted frequently).
  checkForUpdatesIfAllowed({ ignoreSnooze: true })
    .catch((e) => {
      log.error("Startup update check failed:", e);
    })
    .finally(() => {
      refreshTrayMenu();
    });
}

function minutesFromNow(timestampMs) {
  const delta = Math.max(0, timestampMs - Date.now());
  return Math.max(1, Math.round(delta / 60000));
}

async function checkForUpdatesIfAllowed({ ignoreSnooze = false, force = false } = {}) {
  if (!app.isPackaged) return { ok: false, reason: "not_packaged" };
  const now = Date.now();
  const lastCheckAt = Number(store.get("lastUpdateCheckAt") || 0);
  if (!force && lastCheckAt && now - lastCheckAt < UPDATE_MIN_CHECK_GAP_MS) {
    return { ok: false, reason: "recently_checked" };
  }

  const snoozedUntil = Number(store.get("updateSnoozedUntil") || 0);
  if (!ignoreSnooze && snoozedUntil && now < snoozedUntil) {
    return { ok: false, reason: "snoozed" };
  }

  store.set("lastUpdateCheckAt", now);
  await autoUpdater.checkForUpdatesAndNotify();
  return { ok: true };
}

function scheduleUpdateChecks() {
  if (!app.isPackaged) return;

  // Record the startup check time (even if it fails, we want to avoid hammering).
  if (!Number(store.get("lastUpdateCheckAt") || 0)) {
    store.set("lastUpdateCheckAt", Date.now());
  }

  setInterval(() => {
    checkForUpdatesIfAllowed().catch((e) => {
      log.error("Background update check failed:", e);
    });
  }, UPDATE_CHECK_INTERVAL_MS);
}

function snoozeUpdate(minutes) {
  const until = Date.now() + Math.max(1, minutes) * 60 * 1000;
  store.set("updateSnoozedUntil", until);
  cancelUpdateCountdown();
  refreshTrayMenu();
  notify("Update snoozed", `We’ll remind you again in ${minutes} minutes.`);
  closeUpdatePromptWindow();
}

function cancelUpdateCountdown() {
  if (updateCountdownTimer) {
    clearInterval(updateCountdownTimer);
    updateCountdownTimer = null;
  }
  updateCountdownEndsAt = null;
}

function startUpdateCountdownIfAllowed() {
  // Respect snooze.
  const snoozedUntil = Number(store.get("updateSnoozedUntil") || 0);
  if (snoozedUntil && Date.now() < snoozedUntil) {
    refreshTrayMenu();
    return;
  }

  cancelUpdateCountdown();
  updateCountdownEndsAt = Date.now() + UPDATE_AUTO_RESTART_DELAY_MS;
  updateCountdownTimer = setInterval(() => {
    const remainingMs = updateCountdownEndsAt - Date.now();
    sendUpdatePromptState();
    if (remainingMs <= 0) {
      cancelUpdateCountdown();
      // If user is currently capturing, defer until the overlay closes.
      if (overlayActive) {
        updateDeferredInstall = true;
        notify("Update ready", "Restart will happen right after your capture finishes.");
        return;
      }
      try {
        autoUpdater.quitAndInstall();
      } catch (e) {
        log.error("quitAndInstall failed:", e);
      }
    }
  }, 1000);

  sendUpdatePromptState();
}

function getUpdateCountdownSecondsRemaining() {
  if (!updateCountdownEndsAt) return null;
  return Math.max(0, Math.ceil((updateCountdownEndsAt - Date.now()) / 1000));
}

function closeUpdatePromptWindow() {
  if (updatePromptWindow && !updatePromptWindow.isDestroyed()) {
    updatePromptWindow.close();
  }
  updatePromptWindow = null;
}

function openUpdatePromptWindow() {
  if (!updateDownloaded) return;
  const snoozedUntil = Number(store.get("updateSnoozedUntil") || 0);
  if (snoozedUntil && Date.now() < snoozedUntil) return;

  if (updatePromptWindow && !updatePromptWindow.isDestroyed()) {
    updatePromptWindow.show();
    updatePromptWindow.focus();
    sendUpdatePromptState();
    return;
  }

  updatePromptWindow = new BrowserWindow({
    width: 440,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: "Send to CRM — Update ready",
    icon: loadAppIcon(),
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  updatePromptWindow.loadFile("update_prompt.html");
  updatePromptWindow.on("closed", () => {
    updatePromptWindow = null;
  });
  updatePromptWindow.webContents.on("did-finish-load", () => {
    sendUpdatePromptState();
  });
}

function openQuotaPromptWindow(payload) {
  const actionUrl =
    String(payload?.quota?.action?.url || payload?.quota?.billing_url || "").trim() ||
    null;
  const userMessage = String(payload?.quota?.user_message || "").trim();
  const actionLabel =
    String(payload?.quota?.action?.label || "Upgrade to Pro").trim() || "Upgrade to Pro";

  lastQuotaPromptPayload = {
    userMessage,
    actionUrl,
    actionLabel,
  };

  if (quotaPromptWindow && !quotaPromptWindow.isDestroyed()) {
    quotaPromptWindow.show();
    quotaPromptWindow.focus();
    sendQuotaPromptState();
    return;
  }

  quotaPromptWindow = new BrowserWindow({
    width: 520,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: "Send to CRM — Upgrade",
    icon: loadAppIcon(),
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  quotaPromptWindow.loadFile("quota_prompt.html");
  quotaPromptWindow.on("closed", () => {
    quotaPromptWindow = null;
  });
  quotaPromptWindow.webContents.on("did-finish-load", () => {
    sendQuotaPromptState();
  });
}

function sendQuotaPromptState() {
  if (!quotaPromptWindow || quotaPromptWindow.isDestroyed()) return;
  quotaPromptWindow.webContents.send("quota:state", {
    userMessage: lastQuotaPromptPayload?.userMessage || "",
    actionUrl: lastQuotaPromptPayload?.actionUrl || null,
    actionLabel: lastQuotaPromptPayload?.actionLabel || "Upgrade to Pro",
  });
}

function sendUpdatePromptState() {
  if (!updatePromptWindow || updatePromptWindow.isDestroyed()) return;
  updatePromptWindow.webContents.send("update:state", {
    updateDownloaded: Boolean(updateDownloaded),
    downloadedUpdateVersion: downloadedUpdateVersion || null,
    countdownSeconds: getUpdateCountdownSecondsRemaining(),
  });
}

ipcMain.handle("update:restartNow", () => {
  try {
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("update:snooze", (event, minutes) => {
  snoozeUpdate(Number(minutes || 0));
  return { ok: true };
});

ipcMain.handle("quota:openBilling", (event, urlRaw) => {
  const url = String(urlRaw || "").trim();
  if (!url) return { ok: false, reason: "empty_url" };
  try {
    shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

// Settings IPC
ipcMain.handle("settings:get", () => {
  const loginSettings = app.getLoginItemSettings();
  return {
    platform: process.platform,
    defaultShortcut: DEFAULT_SHORTCUT,
    authToken: store.get("authToken") || "",
    apiBaseUrl: getApiBaseUrl(),
    shortcut: store.get("shortcut") || DEFAULT_SHORTCUT,
    startOnLogin: Boolean(store.get("startOnLogin")),
    effectiveStartOnLogin: Boolean(loginSettings?.openAtLogin),
    startOnLoginUserSet: Boolean(store.get("startOnLoginUserSet")),
  };
});

ipcMain.handle("settings:set", (event, partial) => {
  const next = partial || {};
  if (Object.prototype.hasOwnProperty.call(next, "authToken")) {
    store.set("authToken", String(next.authToken || ""));
  }
  if (Object.prototype.hasOwnProperty.call(next, "apiBaseUrl")) {
    store.set("apiBaseUrl", String(next.apiBaseUrl || DEFAULT_API_BASE_URL));
  }
  if (Object.prototype.hasOwnProperty.call(next, "startOnLogin")) {
    store.set("startOnLogin", Boolean(next.startOnLogin));
    applyStartOnLoginFromStore();
  }
  return { ok: true };
});

ipcMain.handle("auth:pair", async (event, tokenRaw) => {
  const token = String(tokenRaw || "").trim();
  if (!token) return { ok: false, reason: "empty_token" };

  try {
    const result = await verifyDesktopToken(token);
    if (!result.ok) {
      return result;
    }
    store.set("authToken", token);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "verify_exception", details: String(e?.message || e) };
  }
});

ipcMain.handle("shortcut:set", (event, shortcutRaw) => {
  const shortcut = String(shortcutRaw || "").trim();
  if (!shortcut) return { ok: false, reason: "empty shortcut" };

  // Validate availability by trying to register it temporarily.
  try {
    globalShortcut.unregisterAll();
    const ok = globalShortcut.register(shortcut, onShortcutPressed);
    if (!ok) {
      registerShortcutFromStore();
      return { ok: false, reason: "shortcut not available" };
    }
  } catch (e) {
    registerShortcutFromStore();
    return { ok: false, reason: String(e?.message || e) };
  }

  store.set("shortcut", shortcut);
  refreshTrayMenu();
  return { ok: true, shortcut };
});

ipcMain.handle("shortcut:reset", () => {
  store.set("shortcut", DEFAULT_SHORTCUT);
  registerShortcutFromStore();
  return { ok: true, shortcut: DEFAULT_SHORTCUT };
});

ipcMain.handle("startup:set", (event, enabled) => {
  try {
    store.set("startOnLogin", Boolean(enabled));
    store.set("startOnLoginUserSet", true);
    applyStartOnLoginFromStore();
    const loginSettings = app.getLoginItemSettings();
    return { ok: true, effectiveStartOnLogin: Boolean(loginSettings?.openAtLogin) };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("updates:check", async () => {
  try {
    await autoUpdater.checkForUpdatesAndNotify();
    return { ok: true };
  } catch (e) {
    log.error("Manual update check failed via IPC:", e);
    return { ok: false, reason: String(e?.message || e) };
  }
});

ipcMain.handle("logs:open", () => {
  const logFilePath = log.transports.file.getFile().path;
  shell.showItemInFolder(logFilePath);
  return { ok: true };
});

ipcMain.handle("downloads:open", () => {
  shell.openExternal("https://github.com/Ben-445/auto-crm/releases/latest");
  return { ok: true };
});

ipcMain.on("area-selected", (event, args) => {
  screenshots.captureArea(args.x, args.y, args.width, args.height);
  console.log(args);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
});

ipcMain.on("cancel-selection", () => {
  if (overlayWindow) {
    console.log("Cancel selection");
    if (!overlayWindow.isDestroyed()) {
      overlayWindow.close();
    }
  }
});

// Screenshot -> upload pipeline
screenshots.on("ok", async (pngBytes, bounds) => {
  try {
    const result = await uploadScreenshotPng(pngBytes, bounds);
    if (result.ok) {
      notify("Screenshot sent", "Your screenshot was uploaded successfully.");
      log.info("Upload ok", result.response?.capture_id || "");
    } else if (result.reason === "quota_exceeded") {
      const msg =
        String(result?.quota?.user_message || "").trim() ||
        "You've reached your monthly limit. Upgrade to Pro for unlimited screenshots.";
      notify("Upgrade required", msg);
      openQuotaPromptWindow(result);
      log.warn("Upload blocked: quota_exceeded");
    } else if (result.reason !== "invalid_token" && result.reason !== "not_paired") {
      notify("Couldn’t send screenshot", "Please try again.");
      log.warn("Upload failed", result.reason, result.details || "");
    }
  } catch (e) {
    notify("Couldn’t send screenshot", "Please try again.");
    log.error("Upload exception", e);
  }
});