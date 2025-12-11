# Screenshot-to-CRM Desktop Client – Product Requirements Document (PRD)

## 1. Overview

**Product name (working):** Screenshot-to-CRM Desktop Client
**Platforms:** Windows + macOS (v1)
**Owner:** Ben / Micro-SaaS Studio

### 1.1 Problem

Account executives and sales reps work across fragmented channels (Slack, WhatsApp Desktop, LinkedIn, email, web apps). Important deal context lives in these tools but **never makes it into the CRM** (e.g., HubSpot), causing:

* Lost or stalled deals due to missed follow-ups
* Incomplete activity history for contacts/opportunities
* Manual copy-paste overhead that reps will not consistently do

### 1.2 Solution (High Level)

A small desktop app that lets a user press a global shortcut, grab a screenshot of any on-screen conversation, and automatically send that screenshot (plus minimal metadata) to a web backend. The backend:

* Runs OCR/processing
* Attempts to match to a CRM contact/account/opportunity
* Creates/updates CRM records accordingly
* If no clear match is found, stores the item for manual review and notifies the account owner.

The desktop app authenticates using a **code/token** that the user obtains from the web application after logging in.

---

## 2. Goals & Non-Goals

### 2.1 Goals (v1)

* Make it **1–2 keystrokes** to capture a relevant conversation snippet and send it to the backend.
* Require **near-zero configuration** after first-time pairing.
* Support **HubSpot** as the initial CRM integration via the backend (desktop app is CRM-agnostic).
* Provide basic **feedback to the user** that the capture was sent successfully or failed.
* Ensure the desktop app **auto-updates** so users are always on a supported version without manual reinstalls.

### 2.2 Non-Goals (v1)

* No in-app CRM browsing or editing in the desktop client.
* No complex annotation/editing of screenshots (beyond the selection itself).
* No direct HubSpot API calls from the desktop app (all go via the backend).
* No offline queueing: if a capture cannot be sent, the app fails loudly and the user can retry manually.

---

## 3. Primary Users & Use Cases

### 3.1 Primary Users

* **Account Executives / Sales Reps** working in:

  * Slack (prospect channels/DMs)
  * WhatsApp Desktop / other chat
  * LinkedIn messages
  * Browser-based email (Gmail/Outlook web) or web apps

### 3.2 Core Use Cases

1. **Capture a prospect message in Slack**

   * User sees a key message from a prospect in Slack.
   * Presses global shortcut.
   * Selects the relevant part of the screen (message + context).
   * Screenshot is sent to backend with user’s auth token and timestamp.
   * Backend matches to a contact/company/deal in HubSpot and logs an activity (e.g., Note) on the CRM timeline.

2. **Capture WhatsApp / LinkedIn chat snippet**

   * Similar flow: shortcut → select area → upload.
   * Backend uses OCR/text to help match contact by name/email/domain/phone.

3. **Capture email snippet or web app view**

   * E.g., snippet from Gmail/Outlook web, or a proposal/review screen.
   * Same capture and upload flow.

4. **Unmatched contact flow** (backend behavior, but relevant to requirements)

   * Backend cannot confidently match screenshot context to a single CRM contact.
   * Backend stores the screenshot and extracted text in a holding area.
   * Backend sends an email notification to the assigned account manager with a link to resolve.
   * AE manually selects the correct contact/company/deal in the web UI; backend then applies the update.

---

## 4. Functional Requirements – Desktop Client

### 4.1 Installation & Startup

* Provide native installers for:

  * Windows (.exe or .msi)
  * macOS (.dmg or .pkg)
* App runs as a background/tray application by default.
* Optional: “Start on system login” toggle in settings.

### 4.2 Authentication & Pairing

* User obtains an **auth code/token** from the web app (after logging in).
* Desktop app has a **Settings** / **Preferences** screen with fields:

  * API base URL (pre-filled, non-editable for normal users, editable via config for internal/testing).
  * “Desktop auth code / API key” input.
* On submit:

  * App validates the code by calling a backend endpoint (e.g., `POST /api/desktop/verify-token`).
  * On success: store a long-lived credential locally and show success state.
  * On failure: show clear error and do not store.
* The stored credential is then attached to every subsequent API call.

### 4.3 Global Shortcut

* Define a default global hotkey (e.g., `Ctrl+Shift+S` on Windows, `Cmd+Shift+S` on macOS).
* Shortcut must work when the user is in any application (Slack, browser, etc.).
* Shortcut should be configurable from the app’s settings (nice-to-have if feasible in v1).
* Prevent conflicts where possible; show an error if the chosen shortcut is not available.

### 4.4 Screenshot Capture

* When the shortcut is pressed:

  * App overlays a semi-transparent layer or enables a system-native region selection mode.
  * User can **click-and-drag to select a rectangular region** of the screen.
  * Provide a simple UX (crosshair cursor, clear selection border) with the ability to cancel (e.g., Esc key).
* After selection:

  * App captures the defined rectangle as an image (PNG or JPEG).
  * App prepares that image for upload (see 4.5).

### 4.5 Upload to Backend API

* After capture, the app should:

  * Immediately send the screenshot to the backend via HTTPS.
  * Include at minimum:

    * Image data (binary or base64-encoded string).
    * Auth token / desktop credential (e.g., in Authorization header).
    * Timestamp of capture (UTC).
    * Basic client metadata (OS, app version).
* API endpoint (example): `POST /api/screenshot-capture`.
* Handle responses:

  * **Success (2xx)**: show a small non-intrusive toast/notification: "Screenshot sent".
  * **Error (4xx/5xx/network)**: show a clear error toast: "Couldn’t send screenshot. [Retry] [Dismiss]".

### 4.6 Error Handling & Offline Behavior

* If the network is unavailable or the backend is unreachable:

  * Show an error and **do not** queue the image; the user can trigger a new capture and resend once they are back online.
* If the auth token is invalid/expired:

  * Show a notification: "Your desktop auth code is invalid. Please re-pair in Settings."
  * Stop sending further requests until re-paired.
  * Show a notification: "Your desktop auth code is invalid. Please re-pair in Settings."
  * Stop sending further requests until re-paired.

### 4.7 UI & Feedback

* Minimal UI footprint:

  * Tray icon (Windows) / menu bar icon (macOS) with context menu:

    * Open Settings
    * Check for Updates (if supported)
    * Quit
  * Optional small main window for settings.
* Notifications:

  * Success: short-lived toast.
  * Failure: toast with simple explanation and optional retry.

### 4.8 Auto-Update (Mandatory v1)

* App should support remote updates without users manually reinstalling.
* Behavior:

  * Check for updates on startup and optionally on a timer (e.g., every 24 hours).
  * If an update is available, download in the background.
  * Prompt user to restart to apply the update.
* Must support both Windows and macOS.

### 4.9 Security & Privacy

* All communication with backend via **HTTPS** only.
* Store auth tokens securely on device (e.g., OS keychain or encrypted local storage).
* Desktop auth tokens are scoped to a single user account and can be revoked from the web application.
* App must handle revoked tokens gracefully (e.g., prompt user to re-pair and stop sending further requests).
* Do not log raw screenshot image data locally beyond what is required for retry.
* Provide a simple privacy note in Settings explaining that screenshots are transmitted to the configured backend and may contain sensitive information.

### 4.10 Logging & Telemetry

* Local logs (for debugging) including:

  * App start/stop.
  * Capture initiated/completed.
  * Upload attempts and outcomes (status codes, error messages).
* Optional: minimal telemetry to backend (e.g., count of captures per user, app version) to support product analytics.

---

## 5. Functional Requirements – Backend (High-Level, for Context)

> Note: Implemented in the web application/server, not in the desktop client, but included here so the client-side interface is clear.

### 5.1 API Endpoints (Conceptual)

1. `POST /api/desktop/verify-token`

   * Input: desktop auth code / API key.
   * Output: success/failure; normalized user identity.

2. `POST /api/screenshot-capture`

   * Auth: bearer token or similar.
   * Input:

     * Image data (PNG/JPEG or base64).
     * Metadata: user, timestamp, OS, app version.
   * Behavior:

     * Store the raw image.
     * Send the image to Lindy AI via webhooks
     * Run OCR / text extraction.
     * Retrieve data from the image
     * Attempt to match to HubSpot contact/company/deal using HubSpot CRM data (e.g., email, domain, phone).
     * On success: create a HubSpot **Note engagement** containing the OCR text and a link or attachment to the screenshot, associated with the matched contact and, where possible, the related company and deal.
     * If match is ambiguous/no match:

       * Store in "unmatched" queue.
       * Trigger notification (e.g., email) to account manager with link to resolve (via Lindy AI with Webhooks).

3. `GET /app/unmatched` (web UI)

   * Provides a UI list for users to manually map unmatched captures to the correct CRM record.

### 5.2 HubSpot Integration (Context)

* Backend is responsible for:

  * Using the HubSpot CRM API to search for potential matches (contacts, companies, deals) based on extracted text (names, emails, domains, phone numbers).
  * Creating/updating **Note engagements** (or similar activities) that contain the OCR text and an optional screenshot link, associated with the matched contact and, where applicable, the related company and deal.
* Desktop app is **not aware** of HubSpot details.

---

## 6. Non-Functional Requirements

### 6.1 Performance

* Time from shortcut press to screenshot being captured: **< 1 second**.
* Upload & response time depends on network, but UI feedback ("uploading..." / spinner) should appear within **500 ms**.

### 6.2 Reliability

* The app should be stable during normal daily use (dozens of captures per day).
* On crash or forced quit, the app should restart cleanly without corrupting settings.

### 6.3 Compatibility

* Windows 10+ (and ideally Windows 11).
* macOS 12+ (Monterey) or as low as is practical while staying within modern APIs.

### 6.4 UX Constraints

* Minimal visual footprint; optimized for speed, not configurability.
* No complex multi-step flows: capture should be at most **two actions** (press shortcut, drag region).

---

## 7. Open Questions / Future Enhancements

* Offline queueing is explicitly out of scope for v1; we may revisit after validating core usage.
* We may later add some text functionality within the desktop to be able to share contact name, but not in this version. 

---

## 8. Definition of Done (v1 Desktop Client)

* Installer available for Windows and macOS.
* User can:

  * Install the app.
  * Obtain an auth code from the web app.
  * Pair the desktop app using that code.
  * Press global shortcut in any app.
  * Draw a rectangle on the screen and confirm capture.
  * See a success notification once the screenshot is uploaded.
* Backend receives the image + metadata, validates auth, and stores the capture.
* Basic error states handled (invalid token, offline, server error) with visible feedback.
* App can check for and apply updates from a remote release source without requiring manual reinstallation.
* Basic logging enabled for diagnostics.
