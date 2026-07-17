# Codex TODO After Claude Design

이 문서는 Claude가 시안으로 구현하거나 보안 능력이 있는 것처럼 mock해서는 안 되는 후속 engineering 범위다. `MODE: IMPLEMENT_AND_HARDEN`에서 실제 코드·test·migration·운영 문서로 완료한다.

## 이미 확인된 구현 모드의 핵심 문제

| 문제 | 확인 수준 | 근거 | 구현 목표 |
|---|---|---|---|
| 전체 재암호화 | 코드로 확인 | `encrypt_files.mjs:54-75`가 기존 blob을 지우고 매번 새 salt, ID, IV, 모든 blob을 생성 | 100개 중 1개 수정 시 새 blob 1개와 새 manifest만 생성 |
| 비트랜잭션 output | 코드로 확인 | 기존 blob cleanup 후 새 output을 같은 directory에 직접 작성, `encrypt_files.mjs:54-127` | temp generation → 전체 검증 → atomic swap, 실패 시 기존 manifest 유지 |
| password change 선반영 | 코드로 확인 | `set_password.mjs:17-28`이 password file을 먼저 쓰고 재암호화 script를 실행 | key wrapping transaction, 실패 시 password와 배포본 함께 rollback |
| staged file 오염 | 코드로 확인 | `auto_sync.py:204`는 output만 add하지만 `:212`의 path 없는 `git commit`이 이미 staged된 외부 파일도 commit | isolated index 또는 path-limited commit, 외부 staged file 불변 test |
| stale `dist/files` blob | fixture로 재현 | build는 target에만 있는 허용 `.bin`을 삭제하지 않는다, `scripts/build_dist.mjs:46-48`; `check_dist`도 reference 검사를 안 함 | manifest가 참조하지 않는 blob은 build/test에서 제거·차단 |
| QR 제한 공유 부재 | 코드로 확인 | `app.js:1327-1350`은 `#file=<id>`만 전달하고 전체 unlock 필요 | 선택 file key만 포함하는 capability, master key 비노출 |
| 공용 기기 종료 부재 | 코드로 확인 | lock은 일부 memory/session만 정리하고 SW는 항상 등록, `app.js:1357-1376,1523-1531` | public mode, SW 미등록, app-managed data cleanup, 정직한 한계 문구 |
| upload/sync 표현 불일치 | 실행과 코드로 확인 | browser는 update ZIP download까지만 수행, `app.js:1087-1125` | 관리자 flow 분리, 실제 상태 machine 또는 `미배포` 명시 |

## 1. Claude 결과 통합

- [ ] Claude screen/component inventory와 `DOM_CONTRACT.md`를 대조한다.
- [ ] 51개 기존 hook을 유지하거나 명시적 adapter layer를 만든다.
- [ ] `createFileItem`, empty/no-result/error renderer를 새 component 구조에 맞춘다.
- [ ] `setButtonContent().replaceChildren()`가 Claude button markup을 지우지 않게 교체한다.
- [ ] 공용 기기, 전체 vault, 관리자 맥락을 실제 route/state/capability로 분리한다.
- [ ] modal focus trap, background `inert`, opener focus restore, Escape, object URL cleanup을 통합한다.
- [ ] 1440×900, 1024×768, 390×844 light/dark와 keyboard flow를 회귀 검증한다.

## 2. Crypto format v2와 migration

- [ ] passphrase → KDF → KEK → wrapped random vault master key → per-file DEK 구조를 설계한다.
- [ ] AES-GCM을 유지하고 context별 AAD, 12-byte nonce uniqueness, key separation을 문서화한다.
- [ ] unchanged file의 immutable ciphertext object를 재사용한다.
- [ ] password rotation은 wrapped master key만 변경하고 blob 변경 0개를 보장한다.
- [ ] manifest version/schema/size/count/field bounds를 엄격히 검증한다.
- [ ] PBKDF2와 Argon2id를 browser 지원, WASM supply chain, mobile memory까지 근거로 결정한다.
- [ ] v1 read와 v1→v2 transactional migration, interruption rollback을 구현한다.
- [ ] 정상/wrong password/ciphertext·tag·AAD tamper/hash/nonce/rotation/migration/rollback test vector를 추가한다.

## 3. 증분·트랜잭션 local pipeline

- [ ] content fingerprint와 stable logical identity 정책을 정한다.
- [ ] temp output에서 생성·reference 검증 후 atomic publish한다.
- [ ] add/modify/delete/no-op/rename/Unicode normalization을 구분한다.
- [ ] source/output overlap과 symlink escape를 차단한다.
- [ ] hidden/OneDrive temp/incomplete download/file-write-stability 정책을 적용한다.
- [ ] config JSON + schema, Windows absolute/relative path, setup/check/dry-run command를 제공한다.
- [ ] config나 log에 passphrase/key/token을 저장하지 않는다.
- [ ] 100 files fixture acceptance: modify 1 → unchanged 99 blobs reuse, new blob 1, manifest 1.

## 4. Sync, Git, deploy hardening

- [ ] output path 외 staged file을 commit하지 않는 isolated index 또는 pathspec transaction을 사용한다.
- [ ] concurrent sync/event storm을 single-flight + queued pass로 처리한다.
- [ ] push failure, commit 후 push failure, non-fast-forward, detached HEAD, wrong remote/branch를 복구 가능한 상태로 남긴다.
- [ ] manifest reference set과 artifact blob set을 정확히 비교해 stale/missing blob을 차단한다.
- [ ] commit/push 성공과 Pages artifact 반영을 별도 상태로 검증한다.
- [ ] action을 commit SHA로 pin하고 최소 permission, CodeQL, dependency review, Dependabot, secret scanning을 추가한다.
- [ ] clean clone에서 check/test/build/artifact verification을 재현한다.
- [ ] Git history plaintext/old decryptable data를 read-only 검사하고 자동 history rewrite는 하지 않는다.

## 5. Browser security와 공용 기기

- [ ] strict manifest schema, ID/path/IV/salt/KDF/size/count/duplicate/Unicode bounds를 적용한다.
- [ ] DOM XSS, selector injection, malicious filename, ZIP traversal test를 추가한다.
- [ ] HTML/SVG/XML/Office/archive preview 차단을 유지하고 PDF iframe sandbox 정책을 결정한다.
- [ ] object URL을 close/error/lock/route/exit 전부에서 revoke한다.
- [ ] meta CSP, Referrer-Policy, Permissions-Policy를 적용하고 GitHub Pages header 한계를 문서화한다.
- [ ] public mode에서는 session persistence, PWA install, service-worker registration, persistent cache를 비활성화한다.
- [ ] exit에서 memory key, app session/local storage, app IndexedDB, app Cache Storage, SW, object URL, preview DOM, URL fragment를 best effort로 정리한다.
- [ ] browser history/download history/downloaded files/OS recent files/printer history는 삭제 불가로 명시한다.

## 6. 제한 공유

- [ ] 신뢰 기기에서 file selection과 capability 생성 UI를 연결한다.
- [ ] selected file DEK만 CSPRNG secret으로 감싸고 master/다른 file key는 포함하지 않는다.
- [ ] secret은 URL fragment로 받고 load 즉시 `history.replaceState()`로 제거한다.
- [ ] static hosting에서 server-enforced expiry/use-count/revocation이 불가능함을 state/copy에 반영한다.
- [ ] 실제 만료가 필요하면 짧은 capability backend를 별도 interface와 threat model로 정의한다.
- [ ] invalid/tampered/removed/expired link UI를 `STATE_MATRIX.md`에 연결한다.

## 7. 관리자 upload 경로

- [ ] 현재 browser update ZIP을 `업데이트 준비 · 미배포` flow로 정확히 연결한다.
- [ ] localhost agent는 strict Origin, pairing secret, CSRF 방지, command allowlist, 외부-site localhost 호출 차단을 갖춘다.
- [ ] backend 없는 remote upload는 작동하는 것처럼 만들지 않고 interface 문서만 제공한다.
- [ ] 향후 remote capability는 ciphertext-only, short expiry, object/size/count limit, replay 방지, orphan cleanup, manifest 권한 분리를 요구한다.
- [ ] long-lived GitHub PAT를 browser code, localStorage, URL, log에 두지 않는다.

## 8. UX state machine와 접근성

- [ ] `STATE_MATRIX.md`의 16개 상태를 typed state로 연결한다.
- [ ] unlock, fetch, decrypt, render, download, ZIP, encrypt, sync, deploy 오류를 분리한다.
- [ ] 실제 단계와 cancelability만 표시한다.
- [ ] auth error description, status live region, `aria-busy`, dialog semantics를 완성한다.
- [ ] 44×44px touch target, WCAG AA contrast, reduced motion, long filename을 자동 검증한다.
- [ ] print dialog open과 실제 print completion을 구분하고 public-exit 안내를 제공한다.

## 9. QA와 성능 합격 조건

- [ ] crypto/file/sync/browser E2E test matrix를 자동화한다.
- [ ] 0-byte, 한글, emoji, long filename, NFC/NFD, no extension, hidden/temp, duplicate, symlink, traversal, external source를 검사한다.
- [ ] event storm, concurrent sync, failure injection, restart recovery를 검사한다.
- [ ] unlock/search/filter/sort/preview/print/download/selection/mobile/keyboard/focus/dark/public-exit/SW-off/fragment removal을 E2E로 검사한다.
- [ ] add/modify/delete/100 중 1 수정/no-op/100MB+/password rotation의 시간, changed blobs, Git delta, peak memory, upload estimate를 v1과 비교한다.

## 10. 문서

- [ ] `README.md`, `SECURITY.md`, `docs/THREAT_MODEL.md`, `docs/ARCHITECTURE.md`, `docs/CRYPTO_FORMAT.md`
- [ ] `docs/OPERATIONS.md`, `docs/RECOVERY.md`, `docs/MIGRATION_V1_TO_V2.md`
- [ ] `docs/PUBLIC_DEVICE_LIMITATIONS.md`, `docs/DESIGN_IMPLEMENTATION.md`
- [ ] history cleanup가 필요하면 backup, `git filter-repo`, force-push 영향, 새 repository 이전, Pages URL 영향을 수동 절차로만 제공한다.

## 구현 완료 gate

- [ ] Claude UI가 실제 runtime state와 연결됨
- [ ] 100개 중 1개 수정 시 blob 1개 + manifest만 변경
- [ ] password rotation 시 blob 변경 0개
- [ ] interruption 시 기존 정상 manifest 유지
- [ ] 외부 staged file 자동 commit 0개
- [ ] stale/missing blob artifact 0개
- [ ] 공용 PC에 master password 없이 선택 파일 접근 경로 존재
- [ ] browser 장기 write token 0개
- [ ] clean clone test/build/E2E와 문서 검증 통과
