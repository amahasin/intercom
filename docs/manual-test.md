# Manual test checklist

Run on physical Windows 11 PCs. These are the checks automated tests cannot make. Record the
date, PC, Windows build and result next to each item, and file anything that fails.

Builds come from `pnpm dist` (or the `installers` artifact of a tagged CI run):
`apps/desktop/release/OfficeMesh-Setup-<version>-x64.exe` and `-arm64.exe`.

## M0. Foundations

### M0.1 Clean-machine developer build

On a Windows 11 PC that has never built the project:

- [ ] Install Node.js 24 LTS, then run `corepack enable`. Clone the repository.
- [ ] `pnpm install` completes without a C++ toolchain installed (no node-gyp compile).
- [ ] `pnpm lint`, `pnpm build` and `pnpm test` all pass.
- [ ] `pnpm e2e` passes (two Electron windows open and close by themselves).
- [ ] `pnpm sim --peers=5` prints five peers with distinct user IDs. Ctrl+C stops them.

### M0.2 Installer as a standard user (x64)

Signed in as a **standard (non-admin)** Windows user:

- [ ] Run `OfficeMesh-Setup-<version>-x64.exe`. The installer is unsigned, so SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**. No elevation prompt appears.
- [ ] The app installs to `%LOCALAPPDATA%\Programs\OfficeMesh` and adds Start menu and desktop shortcuts named OfficeMesh with the OfficeMesh icon.
- [ ] The app opens within 3 seconds and shows "Welcome, <your Windows full name or login name>", a 32-character user ID, six safety-phrase words, Profile "default", and Key protection "Protected by your Windows account".
- [ ] The title bar shows Mica (the desktop colour tints through) and the native minimise, maximise and close buttons.
- [ ] Data is in `%LOCALAPPDATA%\OfficeMesh\default` (`officemesh.db`, `identity.key`, `chromium\`).
- [ ] Close and reopen the app: the same user ID appears.
- [ ] Launch the app a second time while it is running: no second window opens and the first comes to the front.
- [ ] Settings > Apps > Installed apps > OfficeMesh > Uninstall removes the program. `%LOCALAPPDATA%\OfficeMesh` (chat data) is kept.

### M0.3 Installer on ARM64

On a Windows 11 ARM64 PC:

- [ ] Repeat M0.2 with `OfficeMesh-Setup-<version>-arm64.exe`. Task Manager > Details shows OfficeMesh.exe with architecture ARM64.

### M0.4 Private key is unreadable from another Windows account

Needs two local accounts, A and B, and an administrator account to copy files.

1. As A: install and launch OfficeMesh once. Note the user ID. Quit from the window's close button.
2. As B (standard user): try to open `C:\Users\A\AppData\Local\OfficeMesh\default`.
   - [ ] Access is denied.
3. As an administrator: copy `C:\Users\A\AppData\Local\OfficeMesh\default` to `C:\Users\B\Desktop\stolen\default` and grant B full control of the copy.
4. As B: run `"%LOCALAPPDATA%\Programs\OfficeMesh\OfficeMesh.exe" --data-root=%USERPROFILE%\Desktop\stolen` (install OfficeMesh for B first if needed).
   - [ ] The app shows "OfficeMesh could not start" with a decryption error. It does **not** show A's user ID, and does **not** create a new identity in the copied folder (`identity.key` is unchanged).
5. As A: launch OfficeMesh normally.
   - [ ] A's original user ID still appears.

### M0.5 Two profiles side by side

- [ ] Create two shortcuts to OfficeMesh.exe with targets ending `--profile=alice` and `--profile=bob`. Both open at once, with window titles "OfficeMesh (alice)" and "OfficeMesh (bob)", different user IDs, and folders `%LOCALAPPDATA%\OfficeMesh\alice` and `\bob`.

### M0.6 Themes and display

- [ ] Settings > Personalisation > Colours > Dark: the app switches to dark without a restart, and the caption buttons stay visible.
- [ ] Settings > Accessibility > Contrast themes > Night sky: the app switches to a high-contrast theme with readable text and visible focus outlines.
- [ ] Settings > Accessibility > Text size at 150%: no text is clipped in the title bar, rail or identity card.
- [ ] Tab through the app rail: each item shows a focus outline, and Enter selects it.

### M0.7 Offline by design

- [ ] Unplug the network cable and disable Wi-Fi, then start the app. It opens normally.
- [ ] With the network connected, run Resource Monitor > Network while the app is open. OfficeMesh makes no TCP connections to non-local addresses.
