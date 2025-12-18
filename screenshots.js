const { desktopCapturer, screen, shell, nativeImage, app } = require("electron");
const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");

class Screenshots extends EventEmitter {
  constructor() {
    super();
    this.bounds = null;
  }

  startCapture() {
    this.bounds = screen.getPrimaryDisplay().bounds;
    this.captureScreen(this.bounds);
  }

  captureArea(x, y, width, height) {
    this.bounds = { x, y, width, height };
    this.captureScreen(screen.getPrimaryDisplay().bounds);
  }

  captureScreen(fullBounds) {
    try {
      const { width, height } = fullBounds;
      const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
      const thumbnailSize = {
        width: Math.round(width * scaleFactor),
        height: Math.round(height * scaleFactor),
      };

      desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize })
        .then(async (sources) => {
          for (const source of sources) {
            console.log("Source: ", source);
            if (source.name === "Entire screen" || source.name === "Screen 1") {
              const fullScreenshot = source.thumbnail;
              // Multiply the bounds by the scaleFactor so cropping happens at the correct position.
              const croppedImage = nativeImage
                .createFromBuffer(fullScreenshot.toPNG())
                .crop({
                  x: Math.round(this.bounds.x * scaleFactor),
                  y: Math.round(this.bounds.y * scaleFactor),
                  width: Math.round(this.bounds.width * scaleFactor),
                  height: Math.round(this.bounds.height * scaleFactor),
                });
              const timestamp = new Date().getTime();

              const pngBytes = croppedImage.toPNG();
              this.emit("ok", pngBytes, this.bounds);

              // Privacy-first default: do not persist screenshots to disk.
              // Enable local saving only if explicitly requested via env var.
              const shouldSave =
                String(process.env.SAVE_SCREENSHOTS_LOCAL || "").trim() === "1";
              if (!shouldSave) {
                this.emit("afterSave", pngBytes, this.bounds, false);
                return;
              }

              // In packaged apps, `__dirname` points inside the asar bundle and is not writable.
              // Save to a user-writable directory instead (Pictures/Send to CRM by default).
              const baseDir = path.join(app.getPath("pictures"), "Send to CRM");
              const screenshotPath = path.join(baseDir, `screenshot_${timestamp}.png`);
              fs.mkdirSync(baseDir, { recursive: true });
              fs.writeFile(screenshotPath, pngBytes, (error) => {
                if (error) {
                  this.emit("afterSave", pngBytes, this.bounds, false);
                  this.emit("cancel", error);
                  return console.log("Error saving screenshot: ", error);
                }
                this.emit("afterSave", pngBytes, this.bounds, true);
                // Show the saved file in the OS file manager.
                shell.showItemInFolder(screenshotPath);
              });
            }
          }
        })
        .catch((error) => {
          console.log("Error capturing screen: ", error);
        });
    } catch (error) {
      console.log("Error capturing screen: ", error);
    }
  }
}

module.exports = Screenshots;