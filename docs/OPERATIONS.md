# Print Drive 운영 절차

## 안전 경계

- 평문 source와 passphrase는 공개 저장소 밖에 둔다.
- encrypted output만 자동 commit 대상으로 둔다.
- `allowedBranch`와 upstream이 정확히 일치하지 않으면 자동 commit하지 않는다.
- sync 오류를 해결하기 위해 force push, 자동 merge, 자동 rebase를 사용하지 않는다.
- 실제 config에는 password, token, PAT를 기록하지 않는다.

## 초기 setup

```powershell
npm ci --ignore-scripts
python -m pip install -r requirements.txt
node scripts/config_cli.mjs setup --source "D:/PrintDrive-Inbox" --output "./files" --branch main --remote origin
git branch --set-upstream-to=origin/main main
node scripts/config_cli.mjs check
node scripts/config_cli.mjs dry-run
```

`setup`은 source와 output을 만들지만 passphrase를 만들거나 읽지 않는다. source directory symlink는 canonical target으로 해석한다. output symlink/junction이 저장소 밖으로 나가면 거부한다. source 안의 symlink file은 처리하지 않는다.

## 기존 source 다시 연결

암호화 vault는 정상이지만 config/state 또는 평문 위치를 잃었다면 먼저 dry-run 분류만 실행한다.

```powershell
npm run source:relink -- --source "D:/PrintDrive-Inbox"
```

출력은 exact, local-only, remote-only, content-changed, moved를 구분한다. 기본 실행은 아무것도 쓰지 않는다.

- `--adopt`: 모든 파일이 exact일 때 manifest/blob은 건드리지 않고 config와 state만 원자 교체한다.
- `--add-replace`: local-only/changed/moved를 반영하되 remote-only를 보존한다.
- `--mirror`: remote-only 제거까지 포함한다. 명시적 확인이 필요하다.
- `--expected-vault-id <32-hex>`: 다른 vault에 잘못 연결하는 것을 막는다.

명령은 먼저 Git fetch와 clean/ahead/behind/diverged 상태를 검사한다. clean·behind-only·local commit 없음일 때만 upstream을 fast-forward하며 dirty/ahead/diverged에서는 encryption 전에 중단한다. v1 migration도 source가 완전히 대응하면 연결 state를 만들고, 대응하지 않으면 성공을 가장하지 않고 relink 안내를 남긴다.

## 수동 운영

```powershell
node encrypt_files.mjs
node check_public_files.mjs
npm test
npm run build
node scripts/check_dist.mjs
git status --short
git add -A -- files
git commit -m "Update encrypted print files" -- files
git push origin main
```

output path를 `files`가 아닌 저장소 내부 경로로 설정했다면 Git path도 그 설정값을 사용한다. build는 configured output을 Pages의 `dist/files`에 매핑하므로 browser URL은 계속 `files/...`이다.

정상 실행은 `.print-drive-state.json`의 filename, size, high-resolution mtime, 가능한 filesystem identity가 일치하는 파일의 SHA-256을 재사용한다. 이 파일은 Git ignored이며 key·passphrase·평문을 포함하지 않는다. 손상되거나 manifest ID/revision과 불일치하면 전체 source scan으로 돌아간다.

```powershell
node encrypt_files.mjs --full-scan
node encrypt_files.mjs --verify-all
```

첫 명령은 source 전체를 다시 hash하고 state를 원자 교체한다. 둘째 명령은 참조 blob 전체를 복호·인증한다. 정기 audit에서는 둘을 함께 사용한다.

## 브라우저 업데이트 패키지 적용

```powershell
npm run update:check -- "C:/Downloads/Print_Drive_Encrypted_Update.zip"
npm run update:apply -- "C:/Downloads/Print_Drive_Encrypted_Update.zip"
node check_public_files.mjs
git status --short
```

dry-run은 ZIP의 중복·unknown entry·traversal·symlink, exact metadata schema, vault ID, base/target revision, add/remove 집합, target object index, object size/hash를 검사하고 아무것도 쓰지 않는다. apply는 같은 검사를 writer lock 안에서 반복하고 transaction directory에 새 object를 durable write한 뒤 object → manifest → 명시된 이전 object 제거 순서로 반영한다. manifest commit 전 실패는 이번 실행이 만든 object를 rollback한다. commit 후 실패는 같은 ZIP을 다시 apply해 정리를 재개할 수 있다. 이 명령은 Git stage, commit, push를 실행하지 않는다.

## 자동 감시

```powershell
python auto_sync.py
```

동기화기는 source 하위 directory를 재귀 감시하고 canonical `/` 상대 경로로 같은 basename을 구분한다. traversal, symlink file/directory, Windows device name, Unicode/case collision은 encryption 전에 거부한다. 이벤트 폭주 시 debounce timer를 하나로 합치고, thread lock과 Git-directory process lock으로 중복 pass를 막는다. `.git/print-drive-sync.lock`은 30분보다 오래되고 기록된 owner process도 더 이상 실행 중이 아닐 때만 자동 회수된다.

실제 vault writer와 password rotation은 별도로 encrypted output 상위의 `.print-drive-vault.lock`을 공유한다. 이 lock은 PID 재사용·ABA 경합으로 live lock을 잘못 지우지 않도록 자동 stale 삭제를 하지 않는다. crash 뒤 남았다면 모든 `node encrypt_files.mjs`, `node set_password.mjs`, `python auto_sync.py` process가 끝났는지 확인한 뒤에만 수동 삭제하고 전체 public guard를 다시 실행한다.

기본 password file은 Git에서 제외되지만 project가 OneDrive·Dropbox 등 동기화 폴더 안에 있으면 cloud client가 별도로 복제할 수 있다. `PRINT_DRIVE_PASSWORD_FILE`을 repository와 동기화 root 밖의 접근 제한 경로로 지정하고 offline backup 정책을 적용한다. 이미 sync된 것으로 의심되면 파일 내용을 출력하지 말고 cloud version history/공유 범위를 확인한 뒤 compromise 절차에 따라 새 VMK generation을 준비한다.

파일은 0.6초 간격 snapshot 세 번에서 이름·크기·mtime이 같아야 안정된 것으로 간주한다. 30초 안에 안정되지 않으면 암호화와 Git commit을 실행하지 않는다. OneDrive offline/recall placeholder는 local availability를 확보할 때까지 거부한다.

source 이름은 동기화 log에 출력하지 않는다. Git 오류의 URL credential과 일반적인 secret query 표시는 redaction한다.

## Git 상태 전이

1. repository top-level, branch, remote, upstream 검증과 remote fetch
2. dirty/ahead/diverged면 encryption 전에 중단; clean behind-only면 `git merge --ff-only @{upstream}`
3. 안정된 재귀 source snapshot 확인과 encryption
4. output만 `git add -A`
5. output 변경이 있으면 `git commit --only`
6. remote를 다시 fetch하고 local pending commit이면 explicit remote/refspec으로 push
7. push 실패 시 local commit을 보존하고 60초 뒤 지연 재시도

다른 path에 이미 staged된 변경은 index에 남고 자동 commit에 포함되지 않는다. output path에 포함된 변경은 자동 sync 권한 범위로 간주한다.

## v2 objectIndex와 build

v2 envelope의 공개 index 계약:

```text
objectIndex = {
  version: 1,
  objects: [{
    blobId: 32 lowercase hex,
    path: "files/<blobId>.bin",
    encryptedSize: safe integer,
    ciphertextSha256: 64 lowercase hex
  }]
}
```

object는 blobId 순으로 strict 정렬되고 중복이 없어야 한다. guard는 전체 v1/v2 envelope schema와 path, 실제 크기, SHA-256, missing/unreferenced object를 검사한다. build는 임시 staging directory에서 external browser assets와 참조 object만 복사하고 검증을 마친 뒤 `dist`를 교체한다. browser asset symlink, inline style/event handler, 누락된 service-worker precache dependency는 검증에서 거부한다. build 실패 시 기존 `dist`를 교체하지 않는다.

v1은 encrypted manifest 밖에서 참조 집합을 알 수 없다. legacy build는 source의 허용형 blob을 전부 배포하며 이 한계를 warning으로 남긴다. stale-free 참조 보장을 위해 v2 migration이 필요하다.

schema 3 encrypted manifest는 각 파일의 NFC-normalized `relativePath`를 보관한다. envelope는 v2를 유지하고 schema 2 루트 파일 읽기도 지원한다. rename/move가 content와 유일하게 일치하면 기존 blob/logical ID를 재사용한다.

## 휴대형 Windows 관리자 흐름

`docs/PORTABLE_UPDATER.md`의 owner setup 뒤 release ZIP을 풀고 `Workspace`에 평문을 둔다. 실행 파일은 loopback UI에서 exact remote commit/tree snapshot을 읽고 로컬 암호화한 다음, encrypted output 경로만 하나의 tree/commit/ref update(`force: false`)로 적용한다. 기준 SHA가 달라지거나 upload가 중단되면 ref를 바꾸지 않는다. 보호 branch 거절은 별도 branch와 PR fallback을 제공하지만 merge/Pages 완료로 표시하지 않는다.

## CI 운영

- PR: verify, CodeQL, dependency review(Dependency graph가 활성화된 저장소만 지원)
- main: unprivileged verify/build와 privileged Pages deploy 분리
- action reference: full 40-character commit SHA
- checkout: `persist-credentials: false`
- dependency: package-lock과 exact Python pin
- history leak check: full-history checkout에서 filename만 검사

filename scan은 blob content 검사를 대신하지 않는다. GitHub secret scanning/push protection과 주기적인 별도 history audit를 함께 사용한다.

## 공용 기기 종료

앱 종료 뒤에도 browser 방문/download history, OS recent files, printer/spooler 기록은 남을 수 있다. 사용자는 browser가 제공하는 guest/private session 종료, 다운로드 파일 삭제, 인쇄 dialog와 printer queue 확인을 직접 수행해야 한다. 앱은 이 외부 기록을 삭제했다고 표시하지 않는다.
