## Print Drive Portable for Windows x64

This Release contains the standalone Windows x64 updater and its SHA-256 sidecar.

- Windows 10/11 x64; no installed Node.js, Git, or Python is required.
- Authentication defaults to a repository-scoped fine-grained personal access token. Device Flow is available only when configured.
- Plaintext files, the vault passphrase, and the GitHub token stay on the local trusted computer and are not included in repository commits or settings.
- The executable is currently unsigned. Verify the `.sha256` sidecar before extracting, and expect Windows or organization policy to show a warning.
- Extract the ZIP before running it. Read `README.txt` and the repository's `docs/PORTABLE_UPDATER.md` for permissions, recovery, and deployment-status details.
