# Crypto format v2

## 알고리즘과 상한

- passphrase → KEK: PBKDF2-HMAC-SHA-256, random 32-byte salt, 기본 650,000회, 허용 200,000–2,000,000회
- VMK, DEK, AES key: 32 bytes
- encryption: AES-256-GCM, 12-byte IV, 128-bit tag
- VMK subkeys: HKDF-SHA-256, info `print-drive:v2:manifest-key`와 `print-drive:v2:dek-wrap-key`
- 기본 padding block: 65,536 bytes; 0 또는 1,024–1,048,576 power-of-two
- 파일 최대 5,000개, plaintext file 최대 512 MiB, manifest plaintext 4 MiB, ciphertext 4 MiB + tag, serialized envelope 8 MiB

PBKDF2는 native Node/Web Crypto 상호운용과 공급망 최소화를 위해 선택했습니다. Argon2id는 memory-hard 장점이 있지만 현재 browser에 native 표준 API가 없어 WASM binary·loader 공급망과 공용/모바일 기기 memory 비용이 추가됩니다. 검증된 pinned implementation과 배포 정책 없이 유행만으로 추가하지 않습니다.

## envelope

```json
{
  "version": 2,
  "app": "print-drive",
  "vaultId": "32 lowercase hex",
  "keySlots": [{ "id": "...", "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 650000, "salt": "base64url" }, "wrappedVaultKey": { "name": "AES-GCM", "iv": "base64url", "data": "base64url" } }],
  "crypto": { "hkdf": { "name": "HKDF", "hash": "SHA-256" }, "cipher": { "name": "AES-GCM", "keyLength": 256, "ivLength": 12, "tagLength": 128 }, "padding": { "blockSize": 65536 } },
  "objectIndex": { "version": 1, "objects": [{ "blobId": "...", "path": "files/<blobId>.bin", "encryptedSize": 0, "ciphertextSha256": "..." }] },
  "manifest": { "schema": 2, "id": "...", "revision": 1, "iv": "base64url", "data": "base64url" }
}
```

키 slot은 평상시 1개, rotation transaction 동안 최대 2개입니다. 공개 `objectIndex`는 build가 passphrase 없이 stale/missing/tampered blob을 검증하기 위한 것이며 파일명·plaintext hash·DEK는 포함하지 않습니다. authenticated manifest와 exact match해야 합니다.

## 파일 entry와 AAD

manifest file은 `logicalId`, immutable `blobId/path`, NFC `name`, `size/paddedSize/encryptedSize`, plaintext/ciphertext SHA-256, `modifiedAt`, `dataIv`, `wrappedDek`를 가집니다. 이름은 case-insensitive NFC 기준 중복이 없어야 하며 경로 구분자, control·bidi control, `.`/`..`를 거부합니다.

AAD는 UTF-8 JSON array의 canonical encoding입니다.

- VMK slot: `["print-drive",2,"vault-key",vaultId,slotId,kdfName,kdfHash,iterations,salt]`
- manifest: `["print-drive",2,"manifest",vaultId,manifestId,revision]`
- wrapped DEK: `["print-drive",2,"dek",vaultId,logicalId,blobId]`
- file: `["print-drive",2,"file",vaultId,logicalId,blobId,size,paddedSize,sha256]`

manifest는 revision마다 새 IV, 변경 파일은 새 blobId·DEK·data IV·wrap IV를 사용합니다. 한 manifest 안에서 data/wrap IV 중복을 거부합니다. 변경되지 않은 immutable entry는 bytes 그대로 재사용합니다.

## rotation과 transaction

password rotation은 기존 password로 VMK와 manifest를 검증한 뒤 새 KEK slot을 추가하고, local password file을 atomic 교체한 후 새 slot만 남깁니다. 장애 주입 각 지점에서 persisted password 중 하나가 유효하도록 dual-slot transition을 사용하며 file blob과 manifest plaintext body는 바뀌지 않습니다.

이 빠른 rotation은 VMK를 유지하므로 노출된 과거 password의 접근 권한을 취소하는 rekey가 아닙니다. Git history에 남은 과거 key slot으로 VMK를 복구할 수 있기 때문입니다. password compromise 대응은 새 VMK·새 file DEK로 전체 vault를 새 generation/저장소에 만들고 과거 배포를 격리하는 절차가 필요합니다.

새 encryption generation은 object를 먼저 durable publish하고 마지막에 verified manifest를 교체합니다. manifest가 commit point입니다. commit 전 실패는 기존 generation을 유지하고 새 orphan을 제거합니다. commit 후 실패는 새 manifest가 참조하는 complete generation을 유지하며 다음 실행에서 복구합니다.
