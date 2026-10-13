# Building a release yourself

A release is two installers, one for ordinary PCs (x64) and one for ARM64 PCs, built on this Windows PC. It takes about 5 minutes and needs no internet once the project is installed.

## One time: what must be installed

| Tool       | Version                         | Check with      |
| ---------- | ------------------------------- | --------------- |
| Windows 11 | any                             | n/a             |
| Node.js    | 24 or newer                     | `node -v`       |
| pnpm       | 11.22 (the project pins it)     | `pnpm -v`       |
| Git        | any (only if you commit or tag) | `git --version` |

From the project folder (the folder you cloned the project into), once, and again whenever `pnpm-lock.yaml` changes:

```bash
pnpm install
```

You do not need Visual Studio, a C++ compiler or Python: the one native part (SQLite) ships prebuilt, and so does the meeting relay. The small remote-control helper (`rcinput.exe`) is compiled during the build by the C# compiler that is part of Windows (.NET Framework 4, in `C:\Windows\Microsoft.NET\Framework64`), so nothing has to be installed for it.

## Every release

Run these in the project folder, in order. Stop at the first thing that fails.

**1. Pick the version number.** It lives in two files, which must match. Raise it in both (for example `0.7.1` to `0.7.2`):

- `package.json` (the line `"version"`)
- `apps/desktop/package.json` (the line `"version"`)

A PC only treats an installer as an update if its version is higher than the one installed, so never reuse a number you have already handed out. As a guide: a fix raises the last number, new features raise the middle one.

**2. Check the code is healthy.**

```bash
pnpm lint
pnpm test
```

`pnpm e2e` drives the real app and takes about 6 minutes; run it before a release you will hand to the whole office. A test or two that pass when rerun alone is a known flake on a busy PC (the reports in `docs/reports` say which).

**3. Build the installers.**

```bash
pnpm dist
```

This does everything in order: type-checks, builds the app into `apps/desktop/dist`, checks that nothing in it points to the internet, then makes both installers. It rewrites `apps/desktop/dist`, so do not run it while a test run that uses the built app is going.

To make only one of the two (faster):

```bash
pnpm build
pnpm --filter @officemesh/desktop exec electron-builder --config electron-builder.yml --win --x64
```

Use `--arm64` instead of `--x64` for the other.

**4. Find the result.** In `apps/desktop/release/`:

- `InterCom-Setup-<version>-x64.exe` for ordinary PCs
- `InterCom-Setup-<version>-arm64.exe` for ARM64 PCs (Windows on Snapdragon and similar)
- the `.blockmap` files and the `win-unpacked` folder are by-products; do not hand them out

**5. Smoke-test what you built.**

```bash
pnpm smoke:packaged
```

It starts the unpacked app with a throw-away profile and passes when the app has created its identity. It does not test the installer or the ARM64 build. Before you hand out a release, also install it on a spare PC and send one message and one call.

**6. Record it.** Write down the file hashes so people can check what they received:

```powershell
Get-FileHash apps\desktop\release\InterCom-Setup-0.7.1-x64.exe -Algorithm SHA256
```

If you use git: `git add -A`, `git commit -m "Release 0.7.1"`, `git tag v0.7.1`.

## Handing it out

- **By hand:** send the right `.exe` to each person. Double-click installs for that user only, with no administrator account, apart from one Windows Firewall prompt (decline it and the app still works, with a banner offering the fix).
- **By GitHub release (the public way):** see "Publishing a release" below. Installed builds look at the project's GitHub releases every few hours, show "InterCom x.y.z is available on GitHub" with Install and restart, and check the download against the SHA-256 that GitHub publishes for the file.
- **By update folder (an office's own way):** copy the two `.exe` files to a shared folder and put its path in Settings > Updates, or build the office's installers with `INTERCOM_OFFICE_UPDATE_FOLDER` set to it (`$env:INTERCOM_OFFICE_UPDATE_FOLDER = '\\fileserver\apps\intercom'` before `pnpm dist`), so nobody has to set it. Each PC checks every 10 minutes and, when it finds a newer version, shows an "Update required" window that cannot be closed until "Install and restart" is used (a call in progress is never cut off). The app picks the right architecture by file name, and only offers an installer that is newer than itself.
- **Silent install for IT:** `InterCom-Setup-0.7.1-x64.exe /S`. It adds no firewall rules; run `resources\firewall.ps1 -Action add -Program "<install folder>\InterCom.exe"` elevated.

Installing a new version over an old one keeps all chats, files and the identity. The first release named InterCom upgrades an OfficeMesh install in place and moves its data folder.

## Signing (optional, recommended for a larger office)

The installers are not code-signed, so Windows SmartScreen shows "Windows protected your PC" the first time: More info, then Run anyway. To remove that you need a code-signing certificate (bought from a certificate authority, or your office's own if every PC trusts it). Set two environment variables in the same PowerShell window before step 3:

```powershell
$env:CSC_LINK = "C:\path\to\certificate.pfx"
$env:CSC_KEY_PASSWORD = "the certificate's password"
pnpm dist
```

Never put the certificate or its password in the project folder or in git. Once the installers are signed, PCs that were told to accept only signed updates will take them from the update folder.

## If something goes wrong

| Symptom                                      | Likely cause and fix                                                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm: command not found` or a wrong version | Install pnpm 11.22 (`corepack enable`, then `corepack prepare pnpm@11.22.0 --activate`)                                                                                                                                                |
| `pnpm dist` fails in the type-check          | A real code error: fix it, the message names the file                                                                                                                                                                                  |
| "check-origins" fails                        | Something in the app references an internet address, which this product forbids; the message names it                                                                                                                                  |
| `EBUSY` or `access denied` while building    | The app, or a test run, still has files in `apps/desktop/dist` or `release` open: close InterCom (tray icon > Quit), stop any test run, try again                                                                                      |
| Installer made but the version looks old     | You changed only one of the two `package.json` files, or built before changing it: fix both and rebuild                                                                                                                                |
| The smoke test fails                         | It prints why (for example "timed out waiting for identity" or "app exited early"). Run `pnpm dist` again; if it still fails, start `apps\desktop\release\win-unpacked\InterCom.exe --profile=smoke-test` by hand and see what happens |
| ARM64 installer made on an x64 PC            | Expected: building does not need ARM64 hardware. Running it does, and none was available to test here                                                                                                                                  |

## Publishing a release on GitHub

The public build looks for updates in this project's GitHub releases (`INTERCOM_GITHUB_REPO`, at build time, names another repository; the default is in `apps/desktop/main/src/main.ts`).

1. Bump `version` in `package.json` and `apps/desktop/package.json`, run `pnpm dist` (see above), and run `pnpm smoke:packaged`.
2. Create a release whose tag is `v` and the version (`v0.14.0`), with these files as its assets, and nothing else that looks like an installer:
   - `InterCom-Setup-<version>-x64.exe` and `InterCom-Setup-<version>-arm64.exe` (the names matter: the app picks its own by name)
   - `SHA256SUMS.txt` (lines of `<sha256>  <file name>`; GitHub also publishes a digest for each file, which the app uses first)
   - `Install-InterCom.cmd` (for a first install without the SmartScreen warning)

   ```
   gh release create v0.14.0 --title "InterCom 0.14.0" --notes-file notes.md `
     apps\desktop\release\InterCom-Setup-0.14.0-x64.exe `
     apps\desktop\release\InterCom-Setup-0.14.0-arm64.exe `
     apps\desktop\release\SHA256SUMS.txt apps\desktop\release\Install-InterCom.cmd
   ```

3. Installed builds notice it within about 6 hours (or at once with Settings > Updates > "Save and check now") and offer "Install and restart". The download is checked against its published SHA-256 and its size before it is run; only GitHub's own hosts are contacted.
4. To make an update required (a window that cannot be closed until it is installed), put a line with `intercom:required` in the release notes. A draft or a pre-release is never offered.

Build the office's own installers with the shared folder built in, so nobody has to set it:

```
$env:INTERCOM_OFFICE_UPDATE_FOLDER = '\\fileserver\apps\intercom'
pnpm dist
```

An update found in that folder is always required. The public installers do not have it.
