# Manual test checklist

Run on physical Windows 11 PCs. These are the checks automated tests cannot make. Record the
date, PC, Windows build and result next to each item, and file anything that fails.

Builds come from `pnpm dist` (or the `installers` artifact of a tagged CI run):
`apps/desktop/release/InterCom-Setup-<version>-x64.exe` and `-arm64.exe`.

## M0. Foundations

### M0.1 Clean-machine developer build

On a Windows 11 PC that has never built the project:

- [ ] Install Node.js 24 LTS, then run `corepack enable`. Clone the repository.
- [ ] `pnpm install` completes without a C++ toolchain installed (no node-gyp compile).
- [ ] `pnpm lint`, `pnpm build` and `pnpm test` all pass.
- [ ] `pnpm e2e` passes (two Electron windows open and close by themselves).
- [ ] `pnpm sim --peers=5 --lan=all` prints five peers with distinct user IDs. Ctrl+C stops them.

### M0.2 Installer as a standard user (x64)

Signed in as a **standard (non-admin)** Windows user:

- [ ] Run `InterCom-Setup-<version>-x64.exe`. The installer is unsigned, so SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**. No elevation prompt appears.
- [ ] The app installs to `%LOCALAPPDATA%\Programs\InterCom` and adds Start menu and desktop shortcuts named InterCom with the InterCom icon.
- [ ] The app opens within 3 seconds and shows "Welcome, <your Windows full name or login name>", a 32-character user ID, six safety-phrase words, Profile "default", and Key protection "Protected by your Windows account".
- [ ] The title bar shows Mica (the desktop colour tints through) and the native minimise, maximise and close buttons.
- [ ] Data is in `%LOCALAPPDATA%\InterCom\default` (`officemesh.db`, `identity.key`, `chromium\`).
- [ ] Close and reopen the app: the same user ID appears.
- [ ] Launch the app a second time while it is running: no second window opens and the first comes to the front.
- [ ] Settings > Apps > Installed apps > InterCom > Uninstall removes the program. `%LOCALAPPDATA%\InterCom` (chat data) is kept.

### M0.3 Installer on ARM64

On a Windows 11 ARM64 PC:

- [ ] Repeat M0.2 with `InterCom-Setup-<version>-arm64.exe`. Task Manager > Details shows InterCom.exe with architecture ARM64.

### M0.4 Private key is unreadable from another Windows account

Needs two local accounts, A and B, and an administrator account to copy files.

1. As A: install and launch InterCom once. Note the user ID. Quit from the window's close button.
2. As B (standard user): try to open `C:\Users\A\AppData\Local\InterCom\default`.
   - [ ] Access is denied.
3. As an administrator: copy `C:\Users\A\AppData\Local\InterCom\default` to `C:\Users\B\Desktop\stolen\default` and grant B full control of the copy.
4. As B: run `"%LOCALAPPDATA%\Programs\InterCom\InterCom.exe" --data-root=%USERPROFILE%\Desktop\stolen` (install InterCom for B first if needed).
   - [ ] The app shows "InterCom could not start" with a decryption error. It does **not** show A's user ID, and does **not** create a new identity in the copied folder (`identity.key` is unchanged).
5. As A: launch InterCom normally.
   - [ ] A's original user ID still appears.

### M0.5 Two profiles side by side

- [ ] Create two shortcuts to InterCom.exe with targets ending `--profile=alice` and `--profile=bob`. Both open at once, with window titles "InterCom (alice)" and "InterCom (bob)", different user IDs, and folders `%LOCALAPPDATA%\InterCom\alice` and `\bob`.

### M0.6 Themes and display

- [ ] Settings > Personalisation > Colours > Dark: the app switches to dark without a restart, and the caption buttons stay visible.
- [ ] Settings > Accessibility > Contrast themes > Night sky: the app switches to a high-contrast theme with readable text and visible focus outlines.
- [ ] Settings > Accessibility > Text size at 150%: no text is clipped in the title bar, rail or identity card.
- [ ] Tab through the app rail: each item shows a focus outline, and Enter selects it.

### M0.7 Offline by design

- [ ] Unplug the network cable and disable Wi-Fi, then start the app. It opens normally.
- [ ] With the network connected, run Resource Monitor > Network while the app is open. InterCom makes no TCP connections to non-local addresses.

## M1. Discovery, presence and 1:1 text chat

Needs two (preferably three) physical Windows 11 PCs on one subnet, with InterCom installed
from the M1 installer. Call them PC-A and PC-B. Note each PC's Windows build and whether it is
wired or on Wi-Fi.

### M1.1 Firewall rules at install

- [ ] Run the installer as a standard user. One UAC prompt appears (Windows PowerShell). Approve it.
- [ ] In PowerShell, `Get-NetFirewallRule -Group InterCom | Format-Table DisplayName, Enabled, Profile` lists "InterCom discovery (UDP)" and "InterCom peer link (TCP)", Enabled, Private and Domain.
- [ ] On a second PC, decline the UAC prompt. The app still installs, opens, and shows "Colleagues may not be able to reach this PC" with a **Fix** button. Fix shows one UAC prompt; after approving, the banner disappears.
- [ ] A silent install (`InterCom-Setup-<version>-x64.exe /S`) shows no UAC prompt and adds no rules. Running `resources\firewall.ps1 -Action add -Program "<install folder>\InterCom.exe"` elevated adds them.
- [ ] Uninstall shows one UAC prompt and removes both rules.

### M1.2 Discovery with no configuration (done-when: 10 s)

- [ ] Start InterCom on PC-A, then on PC-B. Within 10 seconds each lists the other under "People on your network" with a green dot, display name and job title (if set).
- [ ] Repeat with PC-B on Wi-Fi and PC-A wired (same subnet).
- [ ] Set one PC's network to **Public** (Settings > Network & internet > your connection). The app shows no banner, and chat, calls and file transfer with the other PCs still work (the firewall rules cover every network profile). On a machine with old Private-only rules, **Fix** in the firewall banner (one elevation prompt) repairs them.

### M1.3 Offline detection (done-when: 2 s on quit, 20 s on power loss)

- [ ] Quit InterCom on PC-B (close the window). PC-A shows PC-B Offline within 2 seconds.
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

- [ ] Quit InterCom on PC-B. On PC-A send "One", "Two", "Three". PC-A shows "Waiting for (name) to come online".
- [ ] Restart InterCom on PC-A (the messages wait there), then start PC-B. All three arrive on PC-B within a few seconds, each exactly once and in order. PC-A changes to "Delivered".
- [ ] Restart PC-B twice more. There are still exactly three messages.

### M1.7 Trust on first use

- [ ] On PC-B, set the display name to the same name as an existing colleague (Edit profile). On PC-A, that person's entry shows "New device or unverified", and the profile card explains why.
- [ ] Compare the six safety-phrase words in PC-A's profile card for PC-B with PC-B's own Welcome page. They match. Mark as verified: a green check appears.

### M1.8 Clock skew

- [ ] On PC-B, turn off "Set time automatically" and move the clock 2 minutes ahead. PC-A shows the "Clocks out of step" banner and stops seeing PC-B. Turn automatic time back on: both recover.

### M1.9 Scale (done-when: 200 peers)

- [ ] From a developer checkout on a PC on the subnet, run `pnpm sim --peers=0 --lite=200 --lan=all`. PC-A's people list shows 200 online within a minute, and scrolls and filters smoothly.
- [ ] In Task Manager > Details, the InterCom utility process running the core stays under 2% CPU once the list has settled.

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
- [ ] Quit InterCom on PC-B. On PC-A post, edit, delete, react and pin. Start PC-B: everything matches PC-A within a few seconds.
- [ ] The typing indicator shows on PC-A while PC-B types, and disappears within 5 seconds of stopping.
- [ ] With PC-B's chat open, PC-A's last message shows "Seen". Turn off read receipts on PC-B (avatar menu > Settings): new messages stay "Delivered".
- [ ] Toggle Urgent (!) on PC-A and send: PC-B shows the URGENT label and a toast even in Do not disturb.

### M2.3 Notifications, tray, badge (done-when: toast inline reply)

- [ ] Close PC-B's window (X): InterCom stays in the tray. A message from PC-A shows a Windows toast with a reply box. Type a reply in the toast and press Enter: PC-A receives it, and **PC-B's window does not open**.
- [ ] Click a toast: the window opens at that chat.
- [ ] The taskbar button shows a red badge with the unread count; it clears once the chat is read. The tray tooltip shows the count.
- [ ] Set PC-B to Do not disturb: normal messages give no toast, urgent ones do. Mute a chat (bell icon): no toasts from it.
- [ ] Tray menu > Quit InterCom closes it. After a restart of Windows, InterCom starts in the tray (Settings > Start InterCom when I sign in, on by default); turning that off stops it.

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
- [ ] Scroll bars (M6.17): at rest no scroll bar is drawn; scrolling the chat list, a long chat, Settings or the calendar shows a thin bar in the theme's grey (lighter in dark mode, warm in Paper and Harbor) that fades about a second after scrolling stops; moving the pointer onto the right edge of a list shows it, and it can be dragged.
- [ ] Poll settings (M6.16): "Allow more than one answer" with "Up to 2" stops a third choice; "Hide who voted" shows "Names hidden" and no "See votes"; "Show results: After a person votes" hides the counts from someone until they vote (the author always sees them); "Close automatically: In 1 hour" shows "Closes in 60 min" and, with a PC's clock moved past the time or after the hour, the poll shows closed on every PC (also on a PC that was off at the time, when it starts) and refuses votes.
- [ ] On a named poll "See votes" lists who chose what; "Copy results" pastes the question, each option's count and percentage and the total; "Withdraw vote" takes a vote back; "Close poll" asks first; a closed poll marks the option with the most votes.
- [ ] Files tab lists the files shared in the channel; the Files rail lists files from every chat and channel; clicking a name opens the message.

### M3.4 Public teams

- [ ] PC-A creates a Public team and adds nobody. On PC-C, Teams > Join a public team: the team is listed within a few seconds. Join: its General channel and earlier posts appear on PC-C, and PC-A's member count rises.
- [ ] A private team is never listed.

### M3.5 Offline members (done-when)

- [ ] Quit InterCom on PC-C. PC-A and PC-B post about 50 messages in a shared team channel, then both quit. Start PC-B only, then PC-C: PC-C receives every message from PC-B although the authors' PC (PC-A) is off.

## M4. Calls and screen sharing

Three physical PCs (PC-A, PC-B, PC-C) with the M4 installer, cameras and headsets, on the same subnet. Ideally a fourth to eighth PC for M4.4.

### M4.1 1:1 calls (done-when: under 2 s)

- [ ] On PC-A open a chat with PC-B and click the camera icon. PC-B rings within a second: an in-app card with a ring tone and a Windows toast. Accept with video: both see and hear each other within 2 seconds.
- [ ] Mute, camera off and on, Hold and Resume on PC-A: PC-B shows "Muted", the avatar instead of video, and "On hold". During Hold PC-B cannot hear PC-A.
- [ ] Click a chat in the rail during the call: the call shrinks to a mini view at the bottom right. "Back to call" restores it.
- [ ] Leave on PC-B: the call ends on both PCs, and Calls (rail) shows it with its duration on both.
- [ ] Settings > Devices: pick another microphone, speaker and camera; the preview and level meter follow. "Make a test call" records 5 seconds and plays them back through the chosen speaker.

### M4.2 Screen sharing (done-when: audio never drops)

- [ ] During a call on PC-A click Share screen: the picker shows screens and windows with thumbnails. Share a screen: PC-B sees it, sharp enough to read small text; PC-A shows a magenta border around the shared screen.
- [ ] Keep talking while starting and stopping the share several times: PC-B never loses PC-A's voice.
- [ ] Share a single window. Then share on PC-B: PC-A's share stops and PC-B's replaces it.

### M4.3 Glare (done-when)

- [ ] On a call, both people press the camera button at the same moment (count down "3, 2, 1"). The call carries on and both cameras toggle. Repeat with Share screen at the same moment: one share stays, the call carries on.

### M4.4 Group calls (done-when: 8 people, 30 minutes)

- [ ] In a group chat of up to 8, click the camera icon: everyone rings; those who accept see everyone. Above 4 people video is lower resolution; above 6 only the 4 most recent speakers show video, and the tiles follow who speaks.
- [ ] Leave the call running 30 minutes: nobody drops.
- [ ] Add people from the call (Add people): they ring and join.
- [ ] Optional, automated: `$env:OFFICEMESH_MESH_MINUTES=30; pnpm e2e m4-mesh` runs 8 app instances on one PC for 30 minutes.

### M4.5 Cable pull (done-when: 10 s)

- [ ] In a three-person call, pull PC-C's network cable. Within 10 seconds PC-A and PC-B remove PC-C's tile and carry on talking.

### M4.6 Do not disturb, busy, missed (done-when)

- [ ] Set PC-B to Do not disturb, then call it from PC-A: PC-B does not ring and shows no toast; PC-A at once shows "… is in Do not disturb and was not rung." PC-B's Activity shows a missed call.
- [ ] While PC-B is in a call with PC-C, call PC-B from PC-A: PC-A sees "… is in another call."
- [ ] Call PC-B and let it ring 30 seconds: PC-A sees "did not answer"; PC-B gets a "Missed call" toast and Activity item. Calls shows it in red, with Call back.

## M5. Meetings

Three physical PCs (PC-A, PC-B, PC-C) with the M5 installer, cameras and headsets. M5.3 needs a typical office laptop.

### M5.1 Scheduling (done-when: offline invitee)

- [ ] Quit InterCom on PC-C. On PC-A, Calendar > New meeting: a title, tomorrow 10:00–10:30, repeat every weekday, invite PC-B and PC-C, Schedule. It appears on PC-A's and PC-B's calendars at once (Day, Work week and Week views).
- [ ] Start PC-C: the meeting appears on its calendar within a minute.
- [ ] On PC-B accept, on PC-C decline: the meeting card in the meeting chat and the calendar details show the answers on every PC.
- [ ] On PC-A (organiser) cancel one occurrence: it shows as cancelled everywhere; the others stay.
- [ ] Schedule a meeting 16 minutes ahead: about a minute later every invitee gets a "… in 15 minutes" toast, once.
- [ ] Meeting card > ... > Export to calendar file: an .ics file opens in Explorer; importing it into Outlook or Google Calendar shows the right times and repetition.

### M5.2 Meet now and joining (done-when: late joiner in 3 s)

- [ ] In a group chat on PC-A click Meet now: a "started a meeting" card appears in the chat on every PC. PC-B joins from the card; PC-C joins a minute later and sees and hears everyone within 3 seconds.
- [ ] Raise hand, react (👏), open the meeting chat beside the call: everyone sees them.
- [ ] On PC-A (organiser): Mute everyone; tile menu > Spotlight PC-B (everyone sees PC-B large); Remove PC-C (PC-C's call ends with a notice). PC-B has no organiser options.
- [ ] More > Devices: switch microphone and speaker during the call.
- [ ] Everyone leaves: the card shows "Meeting ended".

### M5.3 Background blur (done-when: 24 fps, turns itself off)

- [ ] On a typical office laptop, More > Blur my background: the background blurs within a few seconds and stays smooth. Others see the blurred video.
- [ ] On an old or heavily loaded PC, blur turns itself off with "Background blur turned off: this PC cannot keep up."

### M5.4 Recording (done-when: banner, file plays)

- [ ] More > Start recording on PC-A: every PC shows the red recording banner, including someone who joins after it started, for the whole recording.
- [ ] Stop: the MP4 appears in the meeting chat and plays there. Show in folder, then open it with Windows Media Player: picture and sound play.

### M5.5 Whiteboard (done-when: simultaneous drawing)

- [ ] Open Whiteboard on two PCs and draw at the same moment, with pen, shapes, text and sticky notes: both boards show exactly the same picture.
- [ ] Share as PNG to the chat: the image appears in the meeting chat.

## M6. Scale-out and release

Three physical PCs (PC-A, PC-B, PC-C) with the M6 installer. PC-A and PC-B on wired gigabit Ethernet with 8 or more logical cores (relay-capable; Settings > Large meetings says so), PC-C on Wi-Fi. M6.3 needs a second subnet (another VLAN, floor or router). M6.5 needs a standard (non-administrator) Windows account on PC-C.

### M6.1 Host relay (done-when: large meeting, host killed)

Three PCs cannot make a meeting of 9, so start the app on each PC from a command prompt with the test switch that moves calls to the relay above 2 people:
`"%LOCALAPPDATA%\Programs\InterCom\InterCom.exe" --relay-above=2`

- [ ] Settings > Large meetings on PC-A and PC-B: "This PC can host meetings of up to 100 people. Wired 1000 Mbps and N logical cores." On PC-C (Wi-Fi): "Can host meetings of up to 25 people; needs wired gigabit Ethernet…".
- [ ] PC-A Meet now in a group chat; PC-B and PC-C join from the card. Everyone sees and hears everyone. PC-A shows "Your PC is hosting this meeting for 3 people · CPU …% · … Mbps out".
- [ ] Share a screen from PC-C: everyone sees it. Mute, camera off and on, raise hand, react: all as in a small meeting.
- [ ] On PC-A, end InterCom in Task Manager (End task). Within 10 seconds PC-B and PC-C show "Reconnecting…", then see and hear each other again; PC-B now shows the hosting line.
- [ ] Repeat, pulling PC-B's network cable instead: PC-C's meeting ends or continues on PC-C capped at 25 ("Up to 25 people: no PC here can host more"), and says why.
- [ ] Windows Defender Firewall > Advanced settings > Inbound rules: "InterCom meeting relay (UDP)" and "(TCP)" exist for `mediasoup-worker.exe`, ports 47802-47817, Private and Domain.
- [ ] Optional, on a wired 8-core PC with the source tree: `node tools/sim/src/relay-load/run.ts --people=100 --minutes=30` passes (host CPU under 70%, recovery under 10 s).

### M6.2 Sealed envelopes (done-when: sender offline, carrier cannot read)

- [ ] Quit InterCom on PC-B. On PC-A send PC-B a direct message: it shows "Will be delivered when … comes online" within a few seconds (PC-C carries it).
- [ ] Quit InterCom on PC-A. Start PC-B: the message arrives from PC-C within a minute.
- [ ] On PC-C, Settings > Diagnostics > Show: "Sealed messages carried for others" went from 1 to 0. Nothing on PC-C shows the message text.
- [ ] Start PC-A: the message shows Delivered.

### M6.3 Other subnets (done-when: one address, full people list)

- [ ] Put PC-C on another subnet (PC-A and PC-B stay together). Nobody sees PC-C.
- [ ] On PC-C, Settings > Diagnostics shows its address. On PC-A, Settings > Colleagues on other floors or subnets: type PC-C's address, Add: "Connected to …".
- [ ] Within a minute PC-B (which nobody typed anything into) and PC-C see each other, with presence; a chat between them works.
- [ ] Restart PC-C: it reappears on PC-A and PC-B within two minutes. Change PC-C's presence to Busy: the others see it within a few seconds.

### M6.4 Moving a profile

- [ ] On PC-A, Settings > Move to another PC: passphrase, Export profile. An `.omprofile` file appears in Downloads.
- [ ] Copy it to PC-C (USB stick). On PC-C, Import a profile…, wrong passphrase: refused. Right passphrase: "…'s profile is ready". Restart now: PC-C is now PC-A's user, with all chats; colleagues see them online (not as a new, unverified person).
- [ ] Uninstall InterCom on PC-A (keep data: no). PC-C's own previous profile is in `%LOCALAPPDATA%\InterCom\default.before-import-…`.

### M6.5 Install and update as a standard user (done-when)

- [ ] Signed in to PC-C as a standard user, run `InterCom-Setup-0.6.0-x64.exe`. It installs without asking for an administrator, except the one firewall prompt (decline it: the app still installs and shows the firewall banner with Fix). If the installer is not code-signed, SmartScreen says "Windows protected your PC": More info > Run anyway.
- [ ] The app runs and chats with PC-A.
- [ ] Put a newer installer (`InterCom-Setup-0.6.1-x64.exe`, built with a raised version) in a shared folder; on PC-C, Settings > Updates: the folder path, Save and check now: "Version 0.6.1 is ready to install". The banner offers Install and restart: the app closes, updates silently and starts again as 0.6.1, with no administrator prompt.
- [ ] A colleague still on 0.6.0 sees "A colleague is running a newer version of InterCom (0.6.1)".
- [ ] Uninstall from Settings > Apps as the standard user: it removes the program (removing the firewall rules asks for an administrator once; declining leaves them).

### M6.6 Diagnostics

- [ ] Settings > Diagnostics > Show: version, addresses, link port, firewall, colleagues, relay capability, database size, recent log lines.
- [ ] Save diagnostics file: a text file in Downloads with no message text in it.

### M6.7 Everything else (done-when)

- [ ] Every item of M0 to M5 above, on these three PCs with the M6 build.

## M6.1 feedback round

Two PCs (PC-A, PC-B) on the M6.1 build. Settings pages named elsewhere in this document (Devices, Large meetings, Diagnostics, Move to another PC, Updates) are now categories in the left pane of the Settings dialog (avatar menu > Settings).

### Chat, files and calls

- [ ] Maximise the window on a wide monitor: messages, the typing line and the composer stay in a centred column no wider than 960 px, in chats, groups and channel posts.
- [ ] PC-A attaches a picture and a large file (drag and drop onto the chat, the paperclip, and paste a screenshot). Nothing is sent: a strip above the box previews each, with a thumbnail for the picture and an X to remove one. PC-B sees nothing yet.
- [ ] PC-A types a message and presses Enter (or clicks Send): the message and the files arrive together, the caption on the first file. Sending with no message works too.
- [ ] Settings > Files on PC-B: "Save received files to" shows `Downloads\InterCom`. Change it to another folder and download a file: it lands there, and the file's Properties show "This file came from another computer".
- [ ] PC-A sends a file of several GB. PC-B's card shows percentage, speed and time left. PC-A's card shows "Sending to <name>" with the same figures. Both lines disappear when it ends.
- [ ] Check PC-A's disk and `%LOCALAPPDATA%\InterCom`: no copy of the sent file exists there.
- [ ] PC-A deletes (or edits) the original of a sent file: its card shows "File is missing". PC-B's saved copy still opens.
- [ ] PC-B deletes a received file: its card shows "File is missing" within a few seconds, with "Download again" while PC-A still has it.
- [ ] A picture sent by PC-A shows PC-B a preview with "click to save". It is not saved until clicked.

### Calls

- [ ] PC-A calls PC-B: PC-A hears a repeating phone ringback (a steady tone, about 1 s on and 3 s off) and PC-B hears the bell-run ringtone (a recording, about 8 s, then a short pause), both through the chosen speaker. Both stop when answered, and a short "connected" chime plays.
- [ ] Hang up from either side: both windows show "Call ended" with the duration and a short tone for about 3 seconds, then close.
- [ ] PC-A cancels while PC-B rings: PC-B shows "Call missed" with Call back. Decline on PC-B: PC-A shows "Call declined". Call someone who is offline or in Do not disturb: PC-A shows "Call unavailable" or "Call declined".

### Settings, status and calendar

- [ ] The status menu has a coloured dot beside each state (green, red, red with a bar, orange, orange clock, grey), and the same dots appear beside people in lists, the chat header and invite pickers.
- [ ] Avatar menu > Edit profile opens Settings on **Profile** (name, status message, picture; Save is enabled only after a change). Visit every category once; each shows its own page and the title matches.
- [ ] Calendar: switch Day, Work week, Week and Month from the view menu. Today, previous and next move the range label. Click a day in the mini month. The red now-line is in today's column; weekends and hours outside 8-17 are shaded.
- [ ] Drag across several 30-minute slots: the New meeting dialog opens with that date and time. Double-click and right-click > New meeting do the same; right-click > Go to today returns to today.
- [ ] Filter > "I organise" hides meetings you were only invited to; the button reads "Filter applied". Meet now starts an instant meeting.
- [ ] Teams, Calls and Activity with nothing selected show their own short explanation, not the open chat or the Welcome card. Files fills the window.

## M6.2 feedback round

Three PCs for the call-waiting steps (PC-A, PC-B, PC-C), two for the rest.

### Name and icon

- [ ] The window title, taskbar, tray tooltip, title bar, installer and Start Menu shortcut all say **InterCom** and show the speech-bubble icon. No place still shows OfficeMesh or the old three-node mark.
- [ ] A new message toast on PC-B is headed **InterCom** with the bubble icon (installed build; a development run shows "InterCom (development)").
- [ ] Updating from OfficeMesh 0.6.0: run the InterCom installer over it. The old chats, identity and files are there, and there is no second entry in Apps > Installed apps.

### Calls in their own windows

- [ ] PC-A calls PC-B. PC-A gets a call window (ringback plays). PC-B gets a small card in the bottom-right corner of the screen, above every other window (also above a full-screen app), with no Windows notification for the call.
- [ ] While the card rings, keep typing in another app on PC-B: the card does not take the keyboard. Drag the card: it moves.
- [ ] PC-B answers. The card closes, PC-B's call window opens, and PC-B's main window is still free: switch chats and send a message during the call. A green bar at the top of the main window shows the call, with **Show call** and **Leave**.
- [ ] Close a call window with its X: the call ends for that PC, as if it had hung up.
- [ ] Maximise a call window on a wide screen with 2, 4 and 8 people: the buttons row is always visible at the bottom and every button works. The window follows the light or dark theme (no dark canvas in light mode).

### A second call while in one

- [ ] While A and B talk, PC-C calls B. B's card says "You are in a call with A" and offers **Hold current call and accept**, **End current call and accept**, **Add to current call** and **Decline**, with soft pings (not the ringtone) and the first call still audible.
- [ ] **Hold current call and accept**: A sees B "On hold" and hears nothing from B. B has two call windows; the old one says it is on hold and has **Resume**. Resume swaps the calls: C then sees B on hold.
- [ ] **End current call and accept**: A's call ends ("Call ended"), B talks with C.
- [ ] **Add to current call**: C's own call is declined and C is invited into the call B is in; C answers and all three talk.
- [ ] **Decline**: C is told "Call declined"; A and B are not disturbed.
- [ ] While one call waits, PC-D calls B: D is told B is busy.
- [ ] A meeting with more people than a direct call can hold (relay) cannot be put on hold: the option is disabled with a reason.

### Remote control

- [ ] A shares a **whole screen**; B sees it and a **Request control** button. A window share shows no button for control (asking says only whole screens can be controlled).
- [ ] B asks: A's call window comes to the front, flashes in the taskbar, and asks **Allow / Deny**. Deny: B reads that control was not allowed. Ask again and Allow: the share border turns orange.
- [ ] B moves the mouse, clicks, scrolls and types over the shared picture: A's real pointer and keyboard do the same, in A's other apps. Clicks on InterCom's own windows on A's screen are ignored.
- [ ] A clicks **Stop control**, or stops sharing, or ends the call: B's control ends at once and nothing stays pressed.
- [ ] Elevated (administrator) windows on A do not obey the controller. That is expected.

### The main window

- [ ] Reactions appear under a message, outside its bubble; hover one for "1 REACTION" with the names.
- [ ] Chat list: the filters (Unread, Chats, Groups), Favorites and Chats sections that fold, the "..." button and right-click menu on a chat (Add to favorites, Mark as unread, Mute, Hide), a chat that is hidden comes back when it has news.
- [ ] A chat has **Chat** and **Shared** tabs; Shared lists its files. Back and forward arrows beside the logo walk through the places you have been.

## M6.3 feedback round

- [ ] Run InterCom from the installer, send yourself a message from another PC while the window is hidden: the toast header says **InterCom** with the bubble icon, and the taskbar button shows the bubble (not the Electron atom). For a development run, the same after the first start (Windows may need a few seconds to notice the new Start Menu shortcut).
- [ ] Settings > General > **Appearance**: Dark turns every window dark at once (main, call windows, the ring card, the title-bar buttons); Light turns them light; **Same as Windows** follows Windows, and switching Windows between light and dark changes the app. The choice is still there after a restart.
- [ ] Right-click a chat (or the "..." button) > **Delete chat** > Cancel: nothing changes. Delete: the chat disappears from the list. On the other PC the messages are still there. Send a message from the other PC: the chat returns with only that message.
- [ ] A group's delete says you stay in the group; Leave is a separate command in the group.
- [ ] Open a DM, then a group: the header has the same height and the Chat and Shared tabs in the same place. The Teams empty state text lines up with the buttons above it, on every line.

## M6.4 feedback round

- [ ] A colleague who is offline: the note under the chat ("… is offline. Messages you send are sealed…") is one block whose lines all start at the same left edge as the box below.
- [ ] Click a colleague's avatar in a chat: the card lists job title, presence, status message, when they were first seen and their network address. The safety phrase is not shown until **Verify identity** is clicked. For a brand-new colleague (warning shown) it is open already.
- [ ] Right-click an offline colleague in "People on your network" (or use "..."): **Remove from list** takes them off, **Remove all offline colleagues from the list** clears the rest. Their chats stay. Start that colleague's PC: they are back in the list. An online colleague has no such menu.
- [ ] After installing on a PC where nobody has run `pnpm sim --lan=all`, the people list holds only real colleagues.

## M6.5 feedback round

- [ ] Set a profile picture (Settings > Profile). It shows at once on the Welcome page, the title-bar avatar, Settings, the people list and chat list on this PC.
- [ ] On another PC, within a few seconds: that picture is in the people list, the chat list, the chat header, beside each of the sender's messages, in the profile card, in call tiles and in the call ring card.
- [ ] Title bar: the search box is clearly a box (white with an outline) in light and dark. Drag the window by the empty title bar on the left of the search box, on the right of it (between it and the avatar), and above it: all three move the window. The avatar button still opens its menu.

## M6.6 feedback round

Three PCs for the meeting steps (PC-A, PC-B, PC-C).

### Files

- [ ] PC-A sends PC-B a file by pressing Enter in the chat: it arrives on PC-B with no click, a progress line with speed and time left, and lands in PC-B's save folder.
- [ ] PC-B: Settings > Files > turn off **Receive files automatically**. PC-A sends another: PC-B shows a Download button and nothing is saved until it is clicked. Turn it back on.
- [ ] Send a file larger than 2 GB (a few GB is enough) between two PCs on the new version: it is offered, transferred with progress, and arrives with the same size and contents. Send one bigger than the free space on PC-B's drive: PC-B says it does not fit, at once.
- [ ] Drag a file over a chat and press Escape or move out of the window: the "Drop files to share them" cover goes away within a second and never stays.

### Calls

- [ ] Call window: Chat, People, Raise hand, React, View, Whiteboard and More are along the top, then Camera and Microphone (with a chevron for devices), Share and a red Leave. With 3, 4, 8 people and a maximised window, no tile runs off the window.
- [ ] People shows everyone; its edge and the chat's edge drag wider and narrower and keep the width next time. In the chat panel the formatting buttons stay inside it.
- [ ] Main window: drag the edge of the chat list: it resizes and keeps the width; double-click resets.
- [ ] Noise suppression (Settings > Calls, or Microphone chevron): with PC-A in a noisy open office, **High** sends only PC-A's voice up close: a colleague across the room, keyboards and fans are lowered. Standard is lighter, Off sends everything.
- [ ] Share a 4K or 1440p screen with text or CAD content to a PC on gigabit: the viewer reads small text without it going soft, and motion is smooth.

### Remote control

- [ ] PC-A shares its **screen**, PC-B clicks **Take control**, confirms "Request control?": PC-A gets a "Presenter mode: B is requesting control" card (and its window comes to the front). Give control: PC-B's mouse, scroll wheel and keyboard drive PC-A's applications, **including when the InterCom call window is maximised behind them**. Both PCs show a pointer with a small avatar; PC-C sees it too.
- [ ] Share a single **window** instead of the screen: control works on that window (a click brings it to the front).
- [ ] If remote control cannot work on PC-A (for example the helper is blocked by security software), PC-B reads that it is not available on PC-A's PC, with a reason; control never "starts" and does nothing.
- [ ] Stop control from PC-A, stop sharing, or end the call: control ends at once on both PCs and no key or button stays pressed.

## M6.7 feedback round

### The chat

- [ ] Open a chat in a wide (maximised) window: the bubbles and the composer have the same left and right edges, 910 px wide, centred. The senders' pictures are outside the bubbles, to their left. Narrow the window: nothing is cut off.
- [ ] Above each message (the first of a run) is a small grey "Name time"; on your own messages just the time, right-aligned. An edited message says Edited on that line. Between days there is a plain centred line: Today, Yesterday, a weekday, or "Tuesday, September 29".
- [ ] Old messages show "Wednesday 4:11 PM" (this week) or "9/29 12:08 PM" (earlier), in the PC's own date format.
- [ ] Rest the pointer on empty space beside a short message: no reaction bar. Move onto the bubble: it appears; react, reply and More work, and the bar stays while More's menu is open.

### Files in the chat

- [ ] Send a PDF, a Word, an Excel, a PowerPoint file, a CSV and a text file. Each shows a card with its icon, name, size, Forward and "..." buttons and a preview of its first page, lines or cells. A PDF says how many pages it has.
- [ ] Click a card: the file opens in the viewer over the chat. **Close** (or Escape) returns to the chat. "..." has Open preview, Open with default app, Show in folder. Forward on the card opens the forward dialog.
- [ ] PDF: scroll through all pages, zoom in and out, Fit, type a page number, search for a word (it is highlighted and the viewer goes to it), select and copy text. A PDF of a few hundred pages opens without waiting for all of it.
- [ ] Word: headings, bold, bullet and numbered lists, tables and pictures show. Excel: each sheet has a tab at the bottom; dates show as dates. PowerPoint: every slide's text, with the note that layout is not shown.
- [ ] A big Office file (over 40 MB) says it is too big and offers Open with default app; a damaged file says it could not be previewed and offers the same.
- [ ] A picture opens in the viewer with zoom and Fit; audio plays in the bubble.
- [ ] Your own sent file and a received one both preview; a file the sender deleted shows "File is missing" as before.
- [ ] Attach a big file (a few GB) and press Send: the composer empties at once and the file shows in the chat as your message with "Preparing the file · n%"; it then becomes the normal message with "Sending to ..." and nothing appears twice. Send three files: each is a bubble, prepared one after another, in order, and the text goes with the first.
- [ ] Attach a file, delete it from the disk, press Send: the bubble says "Not sent" with the reason. Put the file back and press Try again: it goes. Remove deletes the bubble.

## M6.8

- [ ] Send a file of several GB: it is in the chat within a second, with Open and Show in folder under its name (not on the right), and the colleague starts receiving it at once. There is no "preparing" wait and nothing is read twice.
- [ ] Narrow the window while the Shared tab is open: names are cut with "..." and never run into "Shared by"; the tooltip shows the full name. The header keeps the person's name and shortens the "New device" badge.
- [ ] Send a file to a colleague whose PC is off. The card says "Waiting for ... to come online". Turn their PC on (with both apps running): the file arrives by itself, even if it has been hours, and the note goes away. Quit and reopen their app while you are away too: it still comes when you are back.
- [ ] Reply to a message from the notification banner: exactly one message is sent. (Needs a real Windows notification; not tried by the tests.)
- [ ] A PC still on 0.9.x cannot receive a file from this version (it shows as unavailable): update it.

## M6.9

- [ ] Start a call from a chat and open Chat in the call window: it looks and works like the main chat (bubbles, day line, delivery status, typing line, file drop, reactions, replies). Say something in it: it is in the direct chat in the main window too.
- [ ] Add a third person to the call. The direct chat leaves the call window and the call's own group takes its place for all three ("Starting the chat..." for a moment on the newcomer's PC). Nobody sees the group in their chat list, and there is no unread badge or banner for it, while the call goes on.
- [ ] End the call without writing anything: the group never appears for anyone. Do it again and write one message (or send a file) in the call chat: when the call ends the group is in everyone's chat list with the message and the file. Add a fourth person mid-call: they are in the group too.
- [ ] A person other than the organiser has only Leave: it closes only their window and the others carry on. The organiser (when three or more are in) has a small arrow on Leave with "End call for everyone"; it asks first, then every window closes, cameras and microphones stop, sharing stops, and remote control ends.
- [ ] The organiser leaves a call of three: the person who joined first now has "End call for everyone".
- [ ] A person on an older build in a call with this build: End for everyone does not reach them until the organiser's hang-up does; their chat panel shows nothing for the group. Update everyone.

## M6.10

- [ ] Call of two: the other person raises a hand: a "1" is on the hand button. Raise yours too: "2". Open People: the count is there, "Add people" opens the colleague picker, and someone chosen is listed as "Calling…" until they answer.
- [ ] Put the call on hold or start a recording: one slim row of chips appears under the control bar (no wide bars), and it is gone when nothing is happening.
- [ ] Group chat, start an audio call, decline on one PC: that PC's group chat has a "Join call" button in its header and a card in the chat. Join; when everyone has left, the card says it ended.
- [ ] A group call of four to six people for ten minutes with a whiteboard picture added and one person starting and stopping screen share: nobody is removed. Pull one PC's cable: its tile goes within about 10 seconds.
- [ ] Microphone menu, Noise suppression: switch High, Standard, Off, High, Standard, listening from another PC each time. With High, keyboard and mouse sounds, and a colleague talking beside you, are not heard while you are silent.
- [ ] Send a 1 GB file to a PC on a gigabit link: about 100 MB/s while the disk keeps up.
- [ ] Put a newer `InterCom-Setup-x.y.z-x64.exe` (and `-arm64.exe`) in `the office’s update share`: within 10 minutes every PC shows "Update required". It cannot be closed; "Install and restart" updates and starts the app. During a call the dialog waits until the call ends.
- [ ] The calendar opens on Week. The whiteboard's Text and Sticky note pop-ups say "Add text" and "Add note". A colleague removed from the side pane is not in New group, Add people, @mentions, Forward or search.

## M6.11

- [ ] In a call, a colleague's chat title, the People list and their profile card say "In a call" (not "Busy"); after the call, "Available".
- [ ] The People rail lists everyone (online first); Chat lists only chats. Picking a person opens the chat and it appears under Chat.
- [ ] Share a screen, record, take control of a screen: each is a chip in the control bar, the shared picture does not get smaller, and Stop control is always visible.
- [ ] Noise High on a busy PC (video call with four people, a whiteboard open): the voice has no crackle or static; keyboard and mouse are not heard while you are silent.
- [ ] Group chat, More, Change picture: everyone sees it in the title and in their chat list; Remove picture takes it away; rename keeps it.
- [ ] Forward: preview of the message, search, tick several chats and people, an optional note, one button; a person with no chat gets one.
- [ ] Dark mode: reaction counts are readable; scroll bars are dark, thin, and appear only when the pointer is over the area.
- [ ] A long status message does not move the Chat and Shared tabs (it is on the profile card). One status dot in the chat title (on the avatar).
- [ ] Delete an urgent message (and one that quotes another): no URGENT label and no quote remain.
- [ ] A new installer on the share: "Update required" cannot be closed, counts down, and installs by itself after 2 minutes; during a call it waits. The update itself shows no SmartScreen warning.
- [ ] First install by double-clicking `Install-InterCom.cmd` beside the installer: no SmartScreen warning.
