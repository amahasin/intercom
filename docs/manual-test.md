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

## M2. Rich messaging

Two physical PCs (PC-A, PC-B) with the M2 installer, on the same subnet. A third PC helps with M2.4.

### M2.1 Formatting, mentions, emoji

- [ ] Type `**bold**`, `*italic*`, `~~strike~~` and `` `code` ``: each formats as you type. Toolbar buttons do the same for selected text. Bulleted and numbered lists, quotes and code blocks work, and Enter inside a code block adds a line instead of sending.
- [ ] Type `@` and pick a colleague: the mention is highlighted. On their PC it is highlighted more strongly and appears in Activity.
- [ ] The emoji picker inserts emoji. Win+period works too.
- [ ] Paste a web address of an intranet page on the LAN (http://<server>/...): a preview card appears before sending and is shown to the recipient. An internet address shows no preview.

### M2.2 Message actions (done-when: round-trip, and after an offline gap)

- [ ] On PC-B, hover a message from PC-A: react 👍, reply, then from More: pin, save, forward (to a third person if available). Each appears on PC-A within a second.
- [ ] On PC-A, edit and delete your own messages; PC-B shows "Edited" and "This message has been deleted." Edit and Delete are not offered on others' messages.
- [ ] Quit OfficeMesh on PC-B. On PC-A post, edit, delete, react and pin. Start PC-B: everything matches PC-A within a few seconds.
- [ ] The typing indicator shows on PC-A while PC-B types, and disappears within 5 seconds of stopping.
- [ ] With PC-B's chat open, PC-A's last message shows "Seen". Turn off read receipts on PC-B (avatar menu > Settings): new messages stay "Delivered".
- [ ] Toggle Urgent (!) on PC-A and send: PC-B shows the URGENT label and a toast even in Do not disturb.

### M2.3 Notifications, tray, badge (done-when: toast inline reply)

- [ ] Close PC-B's window (X): OfficeMesh stays in the tray. A message from PC-A shows a Windows toast with a reply box. Type a reply in the toast and press Enter: PC-A receives it, and **PC-B's window does not open**.
- [ ] Click a toast: the window opens at that chat.
- [ ] The taskbar button shows a red badge with the unread count; it clears once the chat is read. The tray tooltip shows the count.
- [ ] Set PC-B to Do not disturb: normal messages give no toast, urgent ones do. Mute a chat (bell icon): no toasts from it.
- [ ] Tray menu > Quit OfficeMesh closes it. After a restart of Windows, OfficeMesh starts in the tray (Settings > Start OfficeMesh when I sign in, on by default); turning that off stops it.

### M2.4 Files and images (done-when: 1 GB, cable pull, hash)

- [ ] Drag a photo into a chat, paste a screenshot (Win+Shift+S, then Ctrl+V), and use the snip button: each appears inline on the other PC without clicking Download.
- [ ] Send a 1 GB file (for example `fsutil file createnew big.bin 1073741824`). On PC-B click Download. Halfway through, pull PC-A's network cable for 10 seconds, then plug it back in. The download resumes from where it was (the percentage does not drop) and completes. In PowerShell, `Get-FileHash` of the file opened on PC-B equals PC-A's.
- [ ] Quit PC-B halfway through a large download and restart it; click Download again: it continues from where it stopped.
- [ ] With the sender offline, a file nobody else holds shows "Available when a colleague who has this file is online". It downloads once the sender is back.
- [ ] Open a downloaded Word or Excel file: it opens in Protected View ("This file originated from another computer"). A received .exe opens Explorer with the file selected and does not run.
- [ ] Settings > Profile picture: choose a picture. Colleagues see it within a few seconds.

### M2.5 Search (done-when: 100,000 messages, under 200 ms)

- [ ] Ctrl+E focuses search. A word from an old message shows a result with the word highlighted; clicking it opens the chat with the message highlighted.
- [ ] Optional: on a test profile, fill 100,000 messages (`pnpm vitest run tests/integration/m2-messaging.test.ts -t search` reports the timing). Search results appear without a visible delay.

## M3. Groups, teams and channels

Three physical PCs (PC-A, PC-B, PC-C) with the M3 installer, on the same subnet.

### M3.1 Group chats

- [ ] On PC-A, Chat > New group chat (people icon next to the search box): name it, pick PC-B and PC-C, Create. The group appears on both other PCs within a few seconds, with the name and "3 people".
- [ ] All three post at the same time. Each PC shows the same messages in the same order, each labelled with its author.
- [ ] On PC-B, People icon > Add people: add a fourth colleague if available. They see the whole earlier history.
- [ ] On PC-C, ... > Rename: the new name shows on every PC. PC-A removes PC-C (People icon > ... > Remove): PC-C shows "You are no longer in this conversation" and receives nothing posted afterwards.
- [ ] Read receipts: once every member has the group open, PC-A's last message shows "Seen".

### M3.2 Teams and channels

- [ ] On PC-A, Teams > Create team: name "Finance", Private, members PC-B and PC-C. The team appears with General on all three PCs.
- [ ] PC-A: team ... > Add channel "Budget" (standard) and "Payroll" (private, with PC-B only). PC-C sees Budget but not Payroll.
- [ ] Members tab: PC-A is Owner. PC-A makes PC-B an owner; PC-B can now add channels. PC-C (a member) has no add or remove options.
- [ ] PC-A and PC-B, both owners, rename the same channel at the same moment (or with PC-B's cable unplugged). After reconnecting, all three PCs show the same name.
- [ ] Archive a channel: it shows "This channel is archived. It is read-only." and has no composer. Restore it.

### M3.3 Posts, threads, announcements, polls

- [ ] In General, Start a post. Turn on Announcement (megaphone), add a headline, send: it shows as a highlighted card with the headline on every PC.
- [ ] On PC-B click Reply under the post and reply. PC-A shows "1 reply"; clicking it expands the thread. A toast tells PC-A that someone replied to their post.
- [ ] Poll (chart icon) in a group and in a channel: everyone votes, counts update on every PC; the author closes the poll and further voting is disabled.
- [ ] Files tab lists the files shared in the channel; the Files rail lists files from every chat and channel; clicking a name opens the message.

### M3.4 Public teams

- [ ] PC-A creates a Public team and adds nobody. On PC-C, Teams > Join a public team: the team is listed within a few seconds. Join: its General channel and earlier posts appear on PC-C, and PC-A's member count rises.
- [ ] A private team is never listed.

### M3.5 Offline members (done-when)

- [ ] Quit OfficeMesh on PC-C. PC-A and PC-B post about 50 messages in a shared team channel, then both quit. Start PC-B only, then PC-C: PC-C receives every message from PC-B although the authors' PC (PC-A) is off.
