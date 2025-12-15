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
const Screenshots = require("./screenshots");

let mainWindow;
let overlayWindow;
let tray = null;
let updateDownloaded = false;
let downloadedUpdateVersion = null;
const screenshots = new Screenshots();

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

  globalShortcut.register("alt+q", () => {
    if (process.platform === "darwin") {
      // Check screen capture permission status on macOS:
      const status = systemPreferences.getMediaAccessStatus("screen");
      if (status !== "granted") {
        // Inform the user and open the Screen Recording settings page
        console.log(
          "Screen capture permission not granted. Please enable it in System Preferences."
        );
        shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenRecording"
        );
        return;
      }
    }
    // Only show the overlay window for selection; keep the hidden main window untouched.
    // This avoids leaving an extra transparent window focused with a crosshair cursor.
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
    }
    createOverlayWindow();
  });
});

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

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
    // Ensure the background window stays hidden so the cursor resets to the previous app.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  });

  overlayWindow.webContents.on("did-finish-load", () => {
    overlayWindow.webContents.send("window-loaded");
  });
}

function setupTray() {
  const icon = loadTrayIcon();
  if (!icon) {
    console.warn("Tray icon not available; tray will not be created.");
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip(`Screenshot CRM (${app.getVersion()})`);
  tray.setContextMenu(buildTrayMenu());

  tray.on("click", () => {
    tray.popUpContextMenu();
  });
}

function buildTrayMenu() {
  const version = app.getVersion();
  const restartLabel = downloadedUpdateVersion
    ? `Restart to update (${downloadedUpdateVersion})`
    : "Restart to apply update";

  return Menu.buildFromTemplate([
    {
      label: `Screenshot CRM — v${version}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Check for updates",
      click: async () => {
        try {
          await autoUpdater.checkForUpdatesAndNotify();
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
  tray.setToolTip(`Screenshot CRM (${app.getVersion()})`);
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

  for (const file of candidateFiles) {
    const iconPath = path.join(__dirname, "assets", "icons", file);
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      return image;
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
    refreshTrayMenu();
    notify(
      "Update ready",
      downloadedUpdateVersion
        ? `Version ${downloadedUpdateVersion} is ready. Restart to apply.`
        : "An update is ready. Restart to apply."
    );
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err);
    log.error("Auto-update error:", err);
    refreshTrayMenu();
    notify("Update error", `Update failed: ${String(err?.message || err)}`);
  });

  autoUpdater.checkForUpdatesAndNotify().catch((e) => {
    log.error("Startup update check failed:", e);
  });
}

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