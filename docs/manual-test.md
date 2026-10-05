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

## M1. Discovery, presence and 1:1 text chat

Needs two (preferably three) physical Windows 11 PCs on one subnet, with OfficeMesh installed
from the M1 installer. Call them PC-A and PC-B. Note each PC's Windows build and whether it is
wired or on Wi-Fi.

### M1.1 Firewall rules at install

- [ ] Run the installer as a standard user. One UAC prompt appears (Windows PowerShell). Approve it.
- [ ] In PowerShell, `Get-NetFirewallRule -Group OfficeMesh | Format-Table DisplayName, Enabled, Profile` lists "OfficeMesh discovery (UDP)" and "OfficeMesh peer link (TCP)", Enabled, Private and Domain.
- [ ] On a second PC, decline the UAC prompt. The app still installs, opens, and shows "Colleagues may not be able to reach this PC" with a **Fix** button. Fix shows one UAC prompt; after approving, the banner disappears.
- [ ] A silent install (`OfficeMesh-Setup-<version>-x64.exe /S`) shows no UAC prompt and adds no rules. Running `resources\firewall.ps1 -Action add -Program "<install folder>\OfficeMesh.exe"` elevated adds them.
- [ ] Uninstall shows one UAC prompt and removes both rules.

### M1.2 Discovery with no configuration (done-when: 10 s)

- [ ] Start OfficeMesh on PC-A, then on PC-B. Within 10 seconds each lists the other under "People on your network" with a green dot, display name and job title (if set).
- [ ] Repeat with PC-B on Wi-Fi and PC-A wired (same subnet).
- [ ] Set one PC's network to **Public** (Settings > Network & internet > your connection). The app shows the "Your network is set to Public" banner, and **Open network settings** opens that page. Switch back to Private and restart the app: the banner is gone.

### M1.3 Offline detection (done-when: 2 s on quit, 20 s on power loss)

- [ ] Quit OfficeMesh on PC-B (close the window). PC-A shows PC-B Offline within 2 seconds.
- [ ] Restart it, then pull PC-B's network cable (or turn off Wi-Fi). PC-A shows Offline within 20 seconds (and not before about 15).
- [ ] Restart it, then hold PC-B's power button (hard power-off). PC-A shows Offline within 20 seconds.
- [ ] Put PC-B to sleep (Start > Power > Sleep). PC-A shows Offline within 2 seconds. Wake it: PC-A shows it online within 10 seconds.

### M1.4 Presence

- [ ] On PC-B, click your avatar and choose Busy, then Do not disturb, then Be right back. PC-A's people list and chat header follow within a second each.
- [ ] Choose Available on PC-B, then leave it untouched for 5 minutes. PC-A shows Away. Move the mouse: Available again within about 15 seconds.
- [ ] Lock PC-B (Win+L). PC-A shows Away. Unlock: Available.
- [ ] Avatar menu > Edit profile: change display name, job title and status message. PC-A shows the new values within 5 seconds.

### M1.5 Messaging (done-when: under 300 ms; survives restart)

- [ ] On PC-A, click PC-B's person row and send "Hello". It appears on PC-B immediately, and PC-A shows "Delivered" under it.
- [ ] Send 20 short messages back and forth quickly. Both PCs show the same order.
- [ ] Restart both apps. The conversation and every message are still there on both, in the same order.
- [ ] Multi-line text (Shift+Enter), emoji typed with Win+period, and a 5,000-character paste all arrive intact.

### M1.6 Offline delivery, exactly once (done-when)

- [ ] Quit OfficeMesh on PC-B. On PC-A send "One", "Two", "Three". PC-A shows "Waiting for (name) to come online".
- [ ] Restart OfficeMesh on PC-A (the messages wait there), then start PC-B. All three arrive on PC-B within a few seconds, each exactly once and in order. PC-A changes to "Delivered".
- [ ] Restart PC-B twice more. There are still exactly three messages.

### M1.7 Trust on first use

- [ ] On PC-B, set the display name to the same name as an existing colleague (Edit profile). On PC-A, that person's entry shows "New device or unverified", and the profile card explains why.
- [ ] Compare the six safety-phrase words in PC-A's profile card for PC-B with PC-B's own Welcome page. They match. Mark as verified: a green check appears.

### M1.8 Clock skew

- [ ] On PC-B, turn off "Set time automatically" and move the clock 2 minutes ahead. PC-A shows the "Clocks out of step" banner and stops seeing PC-B. Turn automatic time back on: both recover.

### M1.9 Scale (done-when: 200 peers)

- [ ] From a developer checkout on a PC on the subnet, run `pnpm sim --peers=0 --lite=200`. PC-A's people list shows 200 online within a minute, and scrolls and filters smoothly.
- [ ] In Task Manager > Details, the OfficeMesh utility process running the core stays under 2% CPU once the list has settled.
