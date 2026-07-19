# Product boundary

## Repository role

**BJDG-CM/print-drive is a deployed personal Print Drive instance.**

This repository serves one existing password-protected GitHub Pages application and stores that owner's encrypted manifest and encrypted file blobs. Its supported visitor journey is:

```text
open URL
→ enter Print Drive password
→ view files
→ preview
→ download
→ print
```

Visitors do not need a GitHub account or GitHub authentication. Repository administration, write credentials, token entry, portable updater downloads, and onboarding controls do not belong in the default visitor interface.

## Separate reusable products

Reusable components are planned for separate repositories:

```text
BJDG-CM/print-drive-template
BJDG-CM/print-drive-manager
```

The template will contain no personal encrypted manifest, encrypted file blob, vault identifier, vault key, password, credential, or recoverable personal content. The Manager will own future general-purpose setup, repository creation, onboarding, and multi-repository management behavior.

These names document responsibility boundaries only. Code in this repository must not assume either repository already exists, is deployed, or exposes any API.

Future Manager development must not occur in `BJDG-CM/print-drive`. Existing repository-specific scripts and the portable updater may remain only as legacy owner-only compatibility paths. They must not be promoted as a universal installer, displayed in the ordinary visitor journey, or treated as a prerequisite for password-based reading, preview, download, or printing.

## Current vault migration safety

The current vault is production data, not template content. Future migration must keep it usable throughout the transition:

- preserve vault ID `30b516ab734603477370e8446a18e893` and the existing vault key;
- do not regenerate `files/manifest.enc`, rotate the key, or rewrite encrypted blobs merely to reorganize products;
- verify the existing password, manifest, and every referenced blob before and after any approved migration;
- stage new Manager/template work without making the current Pages application depend on it;
- keep the present password-only visitor flow available until an explicitly verified replacement is deployed;
- use backups and a reversible cutover plan for any future encrypted-data change.

Build, documentation, test, or UI-boundary changes in this repository must leave `files/manifest.enc` and `files/*.bin` byte-for-byte unchanged. If an unrelated operation changes encrypted output, stop before committing and investigate.
