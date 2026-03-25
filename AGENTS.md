<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Firmware (ESP32 Car Tracker) — golden rule

**Mandatory:** Any change to `esp32-firmware/CarTracker.ino` (or other in-repo firmware that replaces that sketch) must **always** be written to the same path in the **same task**:

`C:\Users\User\OneDrive\Documents\Arduino\Car Tracker\CarTracker\CarTracker.ino`

The repo copy and the Arduino IDE copy must stay identical. Update the first-line version comment (`//ver… date time`) in **both** files. Do not overwrite `secrets.h` there unless the user asks.

See also `.cursor/rules/firmware-cartracker-upload-mirror.mdc` (`alwaysApply: true`).
