# Architecture

```text
외부/로컬 source ── encrypt_files.mjs ──> tracked encrypted output
       │                    │                 manifest.enc + immutable .bin
       │                    └─ local passphrase file
       └─ auto_sync.py ── guarded output-only commit/push

encrypted output ── public guard ── clean staging build ──> dist ──> GitHub Pages
                                                        browser app
```

## 로컬 data plane

`config.mjs`와 `paths.mjs`가 source/output/passphrase 경계를 canonical path로 검증합니다. source는 저장소 밖 절대경로를 사용할 수 있지만 output은 저장소 내부의 제한된 디렉터리여야 합니다. source/output 중첩, root·`.git`·`dist`·`node_modules`, output symlink escape와 unsafe password path는 거부합니다.

`encrypt_files.mjs`는 v2 manifest를 unlock하고 source fingerprint를 기존 authenticated entry와 비교합니다. 내용이 같은 unambiguous file은 blob/DEK를 재사용하고 변경 파일만 새 immutable object를 만듭니다. 새 object와 manifest를 staging에서 생성·검증한 후 manifest를 commit point로 교체하고 그 뒤 orphan을 정리합니다. `set_password.mjs`는 dual-slot VMK wrapping으로 password file과 envelope 사이에 항상 사용할 수 있는 slot이 남도록 전환합니다. 암호화, migration, rotation은 모두 output 상위의 `.print-drive-vault.lock`을 원자적으로 획득하므로 직접 실행과 auto-sync writer가 겹치면 덮어쓰지 않고 한쪽이 중단합니다.

## 동기화 control plane

`auto_sync.py`는 top-level source 이벤트를 debounce하고 stable snapshot을 기다립니다. process/repository lock으로 동시 실행을 막고, output path만 stage/commit합니다. branch, remote, upstream, ahead/behind를 검증하며 push 실패 commit은 보존하고 재시도합니다. non-fast-forward에서는 merge/rebase/force push를 하지 않습니다.

## 배포 plane

`public_files_guard.mjs`는 v2 public envelope 전체 schema와 공개 `objectIndex`를 검사하고 실제 object의 크기·SHA-256·orphan 여부를 검증합니다. build는 새 temporary staging에 browser dependency graph와 참조 object만 복사한 뒤 검증하고 `dist`를 교체합니다. 현재 tracked `files/`가 v1이면 명시적인 legacy 호환 경고를 내며 참조 집합을 증명하지 못합니다.

CI는 unprivileged verify/build와 Pages 권한 deploy를 분리합니다. workflow는 최소 permission과 SHA-pinned action을 사용합니다.

## 브라우저 plane

head의 외부 `bootstrap.js`가 capability fragment를 먼저 캡처·제거하고 local module graph를 시작합니다. trusted vault는 passphrase/session key로 manifest를 열고 필요할 때만 object를 same-origin fetch합니다. service worker는 trusted unlock 뒤에만 등록합니다.

public capability는 선택 파일 DEK만 암호화해 전달합니다. public 진입은 진행 중 trusted operation과 late SW registration을 무효화합니다. idle/expiry/lock/route/pagehide는 deadline·epoch·AbortController를 사용하고 object URL, print frame, DOM과 app-owned browser data를 정리합니다.

브라우저의 파일 추가 UI는 암호화 update ZIP을 내려받을 뿐 저장소 upload/deploy를 수행하지 않습니다. 장기 PAT나 쓰기 token은 browser에 두지 않습니다.
