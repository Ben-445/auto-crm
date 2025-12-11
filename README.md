# Screenshot Capture and Upload Application [ WIP ]

This project is a simple Electron-based application that allows users to capture screenshots. 
The application uses Electron's desktopCapturer API for capturing screenshots.

## Features

- Capture screenshots of the entire screen or a specific area.
- Convert screenshots to base64 strings for easy transmission.

## Technologies Used

- **Electron**: A framework for building cross-platform desktop applications using web technologies.

## Installation

1. Clone the repository:

    ```bash
    git clone https://github.com/Ben-445/auto-crm.git
    ```

2. Navigate to the project directory:

    ```bash
    cd electron-screenshot
    ```

3. Install dependencies:

    ```bash
    npm install
    ```

4. Start the application:

    ```bash
    npm start
    ```

## Distribution & Auto-Update

- Build installers (unsigned dev builds): `npm run dist`
- Publish a release to GitHub (requires `GH_TOKEN` with `repo` scope):

  ```bash
  GH_TOKEN=YOUR_TOKEN npm run publish
  ```

- The app checks GitHub Releases for updates at startup and downloads them silently; it restarts after an update is ready.
- Website download link: point to the latest GitHub Release assets (e.g., `https://github.com/Ben-445/auto-crm/releases/latest`).
- Code signing: add Apple Developer ID (macOS) and a Windows code-signing cert before shipping to users.

## Custom App Icon

- Replace `assets/icons/icon.png` with your logo (1024x1024 PNG, transparent background recommended).
- Optional: add `assets/icons/icon.ico` (Windows) and `assets/icons/icon.icns` (macOS). If they’re missing, the PNG will be used and converted during packaging.
- The app window/tray/dock will use this icon when available, and installers will pick it up via `electron-builder`.

## Usage

1. Create an `uploads` folder at the root of the project
2. Launch the application.
3. Capture a screenshot of the desired area or the entire screen by using the keyboard shortcut configured in [main.js](main.js) (Alt + I)

> [!WARNING]
> On macOS 10.15 Catalina or higher, capturing the user's screen requires the user's consent ([source](https://www.electronjs.org/docs/latest/api/desktop-capturer#methods))

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.