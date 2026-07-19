# Local source recovery

Use this procedure when the repository and encrypted `files/` directory still exist but the original plaintext source folder is empty, missing, or no longer connected.

## Current Google Drive layout

The Google Drive folder contains a full development checkout, including `.git`, `node_modules`, `dist`, `files`, and an empty `private_files` directory. It must not be selected as the plaintext source root.

The passphrase file must also be moved outside the Google Drive-synced folder before normal operation. Set its location with `PRINT_DRIVE_PASSWORD_FILE`.

## Restore the source folder

Choose a local folder outside the repository and outside Google Drive synchronization when possible.

```powershell
$env:PRINT_DRIVE_PASSWORD_FILE = "C:\Users\<user>\AppData\Local\PrintDrive\passphrase"

npm run source:restore -- `
  --source "D:\PrintDrive-Inbox" `
  --out ".\files" `
  --expected-vault-id "30b516ab734603477370e8446a18e893"
```

The command:

1. reads the existing encrypted manifest and blobs;
2. unlocks the current vault with the existing passphrase;
3. restores every plaintext file into a temporary directory;
4. verifies file count, logical path, size, and SHA-256 against the manifest;
5. replaces the target source directory only after the full verification succeeds;
6. rebuilds `print-drive.config.json` and `.print-drive-state.json`;
7. leaves `files/manifest.enc` and all encrypted blobs unchanged.

The target source directory must be missing or empty. `--force-empty` is available only for a reviewed recovery where the existing target contents may be removed.

## Verify the restored setup

```powershell
npm run config:check
npm run sync:dry-run
npm run source:relink -- --source "D:\PrintDrive-Inbox" --adopt
npm run verify:production
```

The relink plan should report an exact match. After that, normal updates can use:

```powershell
python auto_sync.py
```

## Important boundaries

- Do not use the repository root as the plaintext source folder.
- Do not use `files/`, `dist/`, `.git/`, or `node_modules/` as the source folder.
- Do not keep the passphrase file in Google Drive, OneDrive, Dropbox, or another synchronized project folder.
- Do not run vault initialization or migration commands during this recovery.
- Keep a backup of the current encrypted `files/` directory before the first recovery attempt.
