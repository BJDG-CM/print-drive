# v1 → v2 migration

v1은 passphrase-derived key 하나로 manifest와 모든 file을 직접 암호화하고 공개 reference index가 없습니다. 따라서 password 변경과 작은 갱신이 전체 blob churn을 만들며 build가 passphrase 없이 정확한 참조 집합을 증명하지 못합니다. 자동으로 포맷을 바꾸지 않습니다.

## 준비

1. auto sync를 종료합니다.
2. 전체 encrypted output과 현재 passphrase file을 서로 일치하는 snapshot으로 별도 backup합니다. 평문 source가 남아 있다면 별도로 backup하지만 migration 입력으로 사용되지는 않습니다.
3. `node check_public_files.mjs`로 현재 v1 envelope allowlist를 확인합니다.
4. v1 manifest와 그 manifest가 참조하는 모든 blob, 그리고 해당 passphrase가 완전해야 합니다. source를 잃었어도 이 세 항목이 온전하면 migration할 수 있지만, passphrase 또는 참조 blob을 잃었다면 migration은 복구 수단이 아닙니다. 이후 증분 sync를 계속하려면 별도의 source 복구가 필요합니다.

## 실행

```powershell
node encrypt_files.mjs --migrate-v1
node check_public_files.mjs
npm run verify
```

명시적인 `--migrate-v1` 없이는 v1 output을 발견한 writer가 중단합니다. migration은 v1 manifest/file을 인증·복호화한 뒤 random VMK와 per-file DEK로 전체를 새 staging generation에 만들고 검증한 다음 v2 manifest를 commit합니다.

## 확인

- envelope `version`이 2이고 strict `objectIndex.version`이 1인지 확인합니다.
- objectIndex entry 수와 `files/*.bin` 수가 같고 public guard가 size/hash/orphan 검사를 통과하는지 확인합니다.
- 브라우저 unlock/preview와 새 passphrase가 동작하는지 synthetic/실제 운영 절차로 확인합니다.
- migration commit은 암호문 전체 변경임을 예상하고 backup을 유지합니다.

## 실패와 rollback

manifest commit 전 실패는 기존 v1 manifest/blob을 유지합니다. 검증되지 않은 v1/v2 파일을 수동 혼합하지 마세요. guard가 실패하면 auto sync를 중지한 채 전체 encrypted-output과 passphrase snapshot을 같은 backup generation으로 복원합니다. 이미 v2 manifest가 commit되고 검증된다면 그 manifest가 authoritative reference 집합이며 unreferenced object는 다음 성공 실행에서 정리할 수 있습니다.
