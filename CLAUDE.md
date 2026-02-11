# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Send to CRM is an Electron-based desktop application that captures screenshots and uploads them to a backend for CRM integration. Users press a global shortcut, select a screen region, and the app automatically sends the screenshot to a Supabase backend that processes it with OCR and matches it to HubSpot contacts.

## Development Commands

### Running the App
```bash
npm start                # Start app in development mode (with --disable-gpu flag)
```

### Building & Distribution
```bash
npm run dist             # Build installers for current platform (unsigned dev builds)
npm run publish          # Publish release to GitHub (requires GH_TOKEN with repo scope)
```

### Platform-Specific Notes
- Windows: Builds NSIS installer with one-click install
- macOS: Builds DMG and ZIP archives
- Icon: Replace [assets/icons/icon.png](assets/icons/icon.png) for custom branding (1024x1024 PNG recommended)

## Architecture

### Main Process ([main.js](main.js))

The main process handles:
- **App lifecycle**: Single-instance lock prevents multiple tray icons
- **Window management**: Multiple BrowserWindows (overlay, settings, update prompts, quota prompts)
- **Global shortcuts**: Configurable keyboard shortcut (default: Ctrl+Shift+S / Cmd+Shift+S)
- **Auto-updates**: electron-updater checks GitHub releases every 24h with countdown + snooze system
- **Settings persistence**: electron-store for auth tokens, shortcuts, API base URL
- **IPC handlers**: Communication between main and renderer processes
- **Tray icon**: System tray menu for settings, updates, and quit

### Screenshot Capture ([screenshots.js](screenshots.js))

EventEmitter-based class that:
- Uses Electron's desktopCapturer API to capture full screen at native resolution
- Handles high-DPI displays (applies scaleFactor for cropping)
- Crops to user-selected region
- Emits 'ok' event with PNG buffer and bounds
- Privacy-first: Screenshots NOT saved locally by default (controlled by SAVE_SCREENSHOTS_LOCAL env var)

### Renderer Windows

- **[select_area.html](select_area.html)**: Fullscreen transparent overlay for region selection
- **[settings.html](settings.html)**: Main settings window for token pairing, shortcut config, startup options
- **[update_prompt.html](update_prompt.html)**: Update restart prompt with countdown timer
- **[quota_prompt.html](quota_prompt.html)**: Upgrade prompt when user hits quota limit

### Authentication & API

- Token-based auth stored in electron-store
- Backend API base URL: `https://ifkhbzakjucaiwoizjux.supabase.co/functions/v1`
- Key endpoints:
  - `POST /desktop-verify-token` - Validates desktop token during pairing
  - `POST /screenshot-capture` - Uploads screenshot with metadata (FormData with image, bounds, timestamp, client metadata)
- Auth failures (401): Token cleared and user prompted to re-pair
- Quota exceeded (403): Opens upgrade prompt, does NOT clear token

### Auto-Update System

- Built on electron-updater + GitHub releases
- Checks on startup and every 24h (minimum 30m gap between checks)
- Downloads silently, prompts user to restart with 5-minute countdown
- Snooze feature (15m / 1h) with persistent state
- Deferred install: If overlay is active during auto-restart, waits until overlay closes
- Manual checks available via tray menu and settings

### Settings & Persistence

electron-store (`settings` config) stores:
- `authToken`: Desktop pairing token
- `apiBaseUrl`: Backend API URL
- `shortcut`: Global keyboard shortcut
- `startOnLogin`: Launch at system startup
- `lastUpdateCheckAt` / `updateSnoozedUntil`: Update scheduling state
- `saveScreenshotsLocally`: Privacy toggle (defaults to false)

## Key Implementation Patterns

### Single-Instance Lock
```javascript
const gotTheLock = app.requestSingleInstanceLock();
```
Prevents multiple app instances. Second launch focuses existing instance and opens Settings.

### High-DPI Screenshot Handling
Screenshots are captured at full resolution using `screen.getPrimaryDisplay().scaleFactor`, then user-selected bounds are multiplied by scaleFactor for accurate cropping.

### Window Management
- Main window: Hidden background window, never shown to user
- Overlay window: Fullscreen transparent window for selection, auto-closes after capture
- Settings window: Frameless with custom title bar (macOS: `titleBarStyle: hidden`)
- All windows use `nodeIntegration: true` and `contextIsolation: false` for direct Electron API access

### Deferred Update Install
If auto-restart countdown expires while overlay is active, install is deferred until overlay closes to avoid interrupting user mid-capture.

### Privacy & Security
- All API communication via HTTPS only
- Auth tokens stored in electron-store (consider OS keychain for production)
- Screenshots NOT persisted to disk by default
- Windows: AppUserModelId set to `com.micro.screenshotcrm` for consistent taskbar icons

## Important URLs

- Connect/pairing: `https://www.sendtocrm.com/connect-desktop`
- Billing/upgrade: `https://sendtocrm.com/settings/billing`
- Downloads: `https://github.com/Ben-445/auto-crm/releases/latest`

## Development Notes

- The app uses `--disable-gpu` flag in npm start (see [package.json](package.json:8))
- macOS requires screen capture permissions (System Preferences > Privacy > Screen Recording)
- Tray icon resized to 16x16 on Windows for proper display
- Update mechanism disabled in development (`!app.isPackaged`)
- Logs: electron-log persists to file, accessible via tray menu "Open logs"
