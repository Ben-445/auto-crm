const {
  app,
  globalShortcut,
  BrowserWindow,
  screen,
  ipcMain,
  systemPreferences,
  shell,
  nativeImage,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const Screenshots = require("./screenshots");

let mainWindow;
let overlayWindow;
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

function setupAutoUpdater() {
  if (!app.isPackaged) {
    console.log("Auto-update disabled in development mode.");
    return;
  }

  autoUpdater.autoDownload = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("Update available:", info?.version || "unknown version");
  });

  autoUpdater.on("update-not-available", () => {
    console.log("No updates available.");
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(
      `Download speed: ${Math.round(progress.bytesPerSecond / 1024)} KB/s, ` +
        `Downloaded ${Math.round(progress.percent)}%`
    );
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("Update downloaded; will install on restart.", info?.version);
    autoUpdater.quitAndInstall();
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err);
  });

  autoUpdater.checkForUpdatesAndNotify();
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