# Print Drive

Print Drive는 개인 기기에서 준비한 파일을 학교·도서관 같은 공용 기기에서 내려받아 인쇄하기 위한 정적 웹앱입니다. 평문 원본과 passphrase는 로컬에만 두고, 공개 저장소와 GitHub Pages에는 암호화 manifest와 immutable `.bin` object만 둡니다.

이 구조가 숨기지 못하는 정보도 있습니다. 저장소와 Pages 방문 여부, 암호문 개수·크기·변경 시각, Git 이력은 공개될 수 있습니다. 약한 passphrase에는 오프라인 추측 공격이 가능합니다.

## 저장소 역할

**BJDG-CM/print-drive is a deployed personal Print Drive instance.**

이 저장소는 소유자의 기존 password-protected Pages 앱, 현재 암호화 vault, 로컬 동기화와 암호화 갱신 흐름만 운영합니다. 범용 설치기, 신규 사용자 onboarding 앱, 저장소 template이 아닙니다. 현재 vault ID와 key를 유지하고, `files/manifest.enc` 및 `files/*.bin`은 확인된 운영 결함을 복구하는 경우가 아니면 다시 만들거나 수정하지 않습니다.

재사용 가능한 구성 요소는 별도 프로젝트로 분리되어 있으며, 이 저장소의 코드가 해당 저장소의 존재를 전제로 하지는 않습니다.

```text
BJDG-CM/print-drive-template
BJDG-CM/print-drive-manager
```

제품 경계와 향후 migration 안전 규칙은 `docs/PRODUCT_BOUNDARY.md`에 고정합니다.

## 요구 사항

- Node.js 24
- Python 3.13과 `watchdog==6.0.0` — 자동 감시를 사용할 때만 필요
- Git
- Web Crypto API를 지원하는 최신 브라우저

기존 Windows 10/11 x64 휴대형 업데이터는 이 인스턴스 소유자만을 위한 legacy compatibility 도구입니다. 일반 방문자나 다른 저장소를 위한 설치기로 제공하지 않습니다.

```powershell
npm ci --ignore-scripts
python -m pip install -r requirements.txt
```

평소 흐름은 `source 폴더 설정 → 암호화/동기화 실행 → 사이트 열기 → 잠금 해제 → 미리보기 또는 인쇄`입니다. 일반 주소는 별도 모드 선택 없이 비밀번호 화면으로 바로 열리고, 선택 파일 공유 주소는 전체 파일 비밀번호 화면을 거치지 않습니다.

## 1. 소유자 전용 로컬 운영 설정

아래 명령은 이미 운영 중인 이 인스턴스의 소유자 workstation을 복구하거나 다시 연결할 때만 사용합니다. 새 Print Drive를 만들거나 다른 사용자를 onboarding하는 절차가 아닙니다.

원본 source는 외부 절대경로를 사용할 수 있습니다. 암호문 output은 저장소 내부여야 하며 저장소 root, `dist`, `.git`, `node_modules`, source와 동일하거나 중첩된 경로는 거부됩니다. Git에서 ignore되는 경로를 output으로 사용하면 자동 commit되지 않으므로 `files` 같은 tracked 경로를 사용하세요.

```powershell
node scripts/config_cli.mjs setup `
  --source "D:/PrintDrive-Inbox" `
  --output "./files" `
  --branch "main" `
  --remote "origin"
```

명령은 소유자의 local `print-drive.config.json`과 필요한 디렉터리를 복구합니다. 실제 config는 machine-local 경로를 포함하므로 Git에서 제외됩니다. tracked example과 schema는 이 인스턴스의 기존 운영 흐름을 검증하기 위한 것이며 범용 onboarding 계약이 아닙니다.

허용되는 key는 다음 다섯 개뿐입니다.

```json
{
  "sourceDirectory": "D:/PrintDrive-Inbox",
  "encryptedOutputDirectory": "./files",
  "autoSync": true,
  "allowedBranch": "main",
  "remote": "origin"
}
```

`sourceDirectory`는 기본 ignored `private_files/`를 쓰거나 저장소 밖의 절대/상대 경로를 지정합니다. 저장소 내부의 다른 폴더는 평문이 `git add`에 포함될 수 있어 config 검사가 거부합니다.

비밀번호, passphrase, token, PAT, credential key는 config 검증 단계에서 거부됩니다.

설정과 Git 연결을 확인합니다. 현재 branch와 upstream도 정확히 일치해야 합니다.

```powershell
node scripts/config_cli.mjs check
node scripts/config_cli.mjs dry-run
```

기존 스크립트를 위한 `PRINT_DRIVE_ROOT`, `PRINT_DRIVE_SOURCE_DIR`, `PRINT_DRIVE_OUTPUT_DIR`, `PRINT_DRIVE_PASSWORD_FILE`, `PRINT_DRIVE_PASSPHRASE` 환경변수는 유지됩니다. config와 환경변수 모두 동일한 output 경계 검증을 통과해야 합니다. custom password file은 저장소 밖에 두어야 하며 source/output 내부 경로는 거부됩니다.

저장소가 OneDrive·Dropbox 같은 동기화 폴더에 있으면 Git에서 제외된 기본 passphrase file도 cloud client가 복제할 수 있습니다. `PRINT_DRIVE_PASSWORD_FILE`을 저장소와 cloud-sync root 밖의 접근 제한 경로로 지정하고 별도 offline backup을 유지하세요.

기존 암호화 vault와 평문 폴더의 연결이 끊겼다면 먼저 쓰기 없는 계획을 확인합니다.

```powershell
npm run source:relink -- --source "D:/PrintDrive-Inbox"
```

완전 일치할 때만 `--adopt`로 state/config를 재구축할 수 있습니다. `--add-replace`는 원격 전용 파일을 보존하고, `--mirror`는 명시적 확인 뒤 source와 같게 만듭니다. vault ID가 예상과 다른 경우에는 중단합니다. 자세한 분류와 복구는 `docs/OPERATIONS.md`와 `docs/RECOVERY.md`를 따르세요.

## 2. 기존 vault 유지와 migration 기록

이 저장소의 production vault는 이미 존재합니다. 이 인스턴스에서 신규 vault 초기화 명령을 실행하거나 vault key/ID를 교체하지 마세요. 다음 명령은 새 배포를 만드는 일반 사용법으로 제공하지 않으며, 별도 backup과 명시적인 복구 계획이 있는 과거-format 복구에만 해당합니다.

```powershell
node encrypt_files.mjs --init-passphrase
```

과거 v1 vault migration 절차는 기록과 복구 호환성을 위해 남아 있습니다. 원본과 현재 암호문을 백업하고 먼저 `docs/RECOVERY.md`를 읽으세요.

```powershell
node encrypt_files.mjs --migrate-v1
```

이 저장소에서 추적하는 production vault는 2026-07-18에 기존 transactional 명령으로 v2 migration과 전체 검증을 완료했습니다.

v2는 passphrase에서 만든 key-encryption key, random vault master key, per-file data key를 분리합니다. 변경되지 않은 파일 object는 재사용되며 password rotation은 file blob을 다시 암호화하지 않습니다.

```powershell
node set_password.mjs
```

CLI argument로 passphrase를 넘기는 방식은 shell history에 남을 수 있으므로 기본적으로 사용하지 않습니다. `.print-drive-passphrase`는 Git에서 제외되지만 별도의 안전한 backup이 필요합니다.

## 3. 평소 파일 갱신

수동 갱신:

```powershell
node encrypt_files.mjs
node check_public_files.mjs
git add -A -- files
git commit -m "Update encrypted print files" -- files
git push origin main
```

v2 encryption은 fingerprint가 같은 object를 재사용하고, 새 manifest를 검증한 후 publish하며, publish가 성공한 뒤 unreferenced blob을 정리합니다. 중간 실패 시 기존 정상 manifest가 기준점으로 남습니다.

`.print-drive-state.json`은 Git에서 제외된 로컬 change-detection cache입니다. 파일 내용이나 key를 저장하지 않으며, 파일 metadata와 이전 SHA-256·manifest 매핑만 보관합니다. vault identity/revision 또는 schema가 맞지 않으면 자동으로 안전한 전체 source scan을 수행합니다.

```powershell
node encrypt_files.mjs --full-scan   # 모든 source 파일 다시 hash
node encrypt_files.mjs --verify-all  # 모든 참조 blob 복호·인증
```

자동 감시:

```powershell
python auto_sync.py
```

자동 동기화기는 다음 경계를 적용합니다.

- source 하위 폴더까지 재귀 감시하며 같은 basename은 `relativePath`로 구분합니다. output 이벤트는 감시하지 않습니다.
- 숨김 파일, Office 임시 파일, OneDrive/브라우저의 incomplete-download suffix를 무시합니다.
- 크기와 수정 시간이 연속 snapshot에서 안정될 때까지 기다립니다.
- symlink file·directory는 암호화 source로 사용하지 않습니다.
- Git top-level, allowed branch, remote, upstream을 commit 전에 확인합니다.
- 암호화 전에 remote를 fetch합니다. clean 상태에서 remote만 앞선 경우에만 `--ff-only`로 갱신하고, dirty/ahead/diverged 상태는 암호화 전에 중단합니다.
- `git add -A -- <output>`과 `git commit --only -- <output>`을 사용하므로 다른 staged 변경을 commit하지 않습니다.
- commit 후 push가 실패해도 local commit을 보존하며 60초 뒤와 다음 실행에서 새 파일 변경 없이도 pending commit을 다시 확인합니다.
- diverged/non-fast-forward에서는 merge, rebase, force push를 자동 실행하지 않습니다.

상세 운영과 복구는 `docs/OPERATIONS.md`, `docs/RECOVERY.md`에 있습니다.

## 4. 소유자 전용 업데이트 흐름

1. **연결된 관리자 source**: `encrypt_files.mjs` 또는 `auto_sync.py`로 재귀 source를 증분 암호화합니다. 연결이 끊겼으면 `source:relink`로 먼저 분류합니다.
2. **Legacy owner-only portable compatibility**: 기존 `PrintDrive-Portable-windows-x64.zip`은 이 저장소와 현재 vault를 위한 호환 도구일 뿐 범용 installer나 권장 Manager가 아닙니다. 기존 Release와 asset은 보존하지만 방문자 UI에서 홍보하지 않습니다. 세부 경계는 `docs/PORTABLE_UPDATER.md`를 봅니다.
3. **Legacy browser package fallback**: owner-only 관리 화면에서 만든 update ZIP을 기존 관리자 checkout에서 검사·적용·push합니다. 일반 방문 흐름에는 관리 진입점을 표시하지 않습니다.

### 브라우저 업데이트 패키지

브라우저 update ZIP 생성 코드는 기존 호환성을 위해 남지만 기본 방문자 UI에서는 진입점을 표시하지 않습니다. 이 흐름은 소유자가 신뢰 기기에서만 사용하는 legacy fallback입니다. ZIP은 저장소에 직접 쓰거나 GitHub token을 보관하지 않습니다. `print-drive-update.json`, 대상 `manifest.enc`, 새 immutable object만 포함하며 교체된 object는 제거 목록에 기록됩니다.

```powershell
npm run update:check -- "C:/Downloads/Print_Drive_Encrypted_Update.zip"
npm run update:apply -- "C:/Downloads/Print_Drive_Encrypted_Update.zip"
node check_public_files.mjs
git add -A -- files
git commit -m "Update encrypted print files" -- files
git push origin main
```

`update:check`는 아무것도 바꾸지 않습니다. `update:apply`는 writer lock 아래에서 package schema, 경로, vault/revision, target object set, 크기와 SHA-256을 다시 확인하고 새 object와 manifest를 원자적으로 반영한 뒤 명시적으로 unreferenced가 된 object만 제거합니다. passphrase를 찾으면 target manifest와 새 object도 인증합니다. 패키지 생성·다운로드 자체는 적용이나 배포가 아닙니다.

공용 기기에는 전체 vault passphrase를 입력하지 않는 제한 공유 capability 흐름을 우선합니다. URL fragment의 capability는 서버로 전송되지 않지만, 정적 호스팅만으로 강제 만료·횟수 제한·회수를 보장할 수는 없습니다.

제한 공유의 현재 browser decrypt 상한은 encrypted object 256 MiB이며, 이보다 큰 파일의 링크 생성은 UI가 거부합니다.

schema 3 vault는 암호화 manifest 안에 안전한 `relativePath`를 저장합니다. 브라우저는 breadcrumb와 폴더 행을 제공하고, 검색·최근 파일은 모든 폴더를 대상으로 하며, 선택·현재 폴더·전체 ZIP은 논리 경로를 보존합니다. 기존 schema 2 루트 파일은 계속 읽을 수 있습니다.

## 5. 검증과 Pages build

```powershell
npm run check
npm test
npm run build
node scripts/check_dist.mjs
npm run verify:production
npm run portable:build
npm run portable:test
npm run benchmark
```

- `npm run check`: JavaScript/Python syntax, workflow SHA pin, tracked/history path leak, public output allowlist와 v2 object integrity를 검사합니다.
- `npm test`: browser/security/crypto test, synthetic temporary Git 장애 주입, encryption smoke test를 실행합니다.
- `npm run build`: 외부 CSS와 bootstrap을 포함한 local JavaScript dependency graph를 그대로 복사하고 검증된 artifact를 임시 디렉터리에서 만든 뒤 `dist`를 교체합니다.
- `npm run verify:production`: 실제 Pages manifest/object의 공개 무결성을 확인하고, local production passphrase가 있으면 Node와 built browser code로 모든 object를 인증·복호화합니다. passphrase가 없으면 복호화하지 않았다고 명시합니다.
- `portable:build`/`portable:test`: Windows x64 SEA ZIP과 SHA-256을 만들고 PATH가 빈 상태에서 실제 실행 파일의 UI asset과 AES-GCM 왕복을 확인합니다.
- `npm run benchmark`: v2의 100-file 증분 변경·전체 audit·rotation과 100 MiB 파일의 시간, source read, 복호화 수, sampled peak RSS를 측정합니다. 결과와 해석은 `docs/PERFORMANCE.md`에 있습니다.
- v2 build는 strict envelope schema와 `objectIndex.version=1`의 path, size, ciphertext SHA-256을 실제 blob과 확인하고 참조된 object만 배포합니다.
- legacy v1에는 공개 object index가 없어 manifest-to-blob 참조를 증명할 수 없습니다. 호환 build는 target stale 파일은 제거하지만 source blob 전부를 복사하므로 가능한 빨리 v2로 migration해야 합니다.

`dist`에는 `index.html`, 외부 CSS/JavaScript와 그 local dependency, PWA asset, `files/manifest.enc`, manifest가 참조하는 `.bin`만 들어갑니다. source에서 삭제된 object가 이전 `dist`에 남지 않도록 매 build를 clean staging에서 만듭니다. browser asset graph와 service worker precache 목록은 테스트에서 정확히 일치해야 합니다.

## 6. CI와 GitHub 설정

Pull request는 verify, dependency review, CodeQL을 실행합니다. `main` deploy workflow는 권한 없는 verify/build job과 `pages:write`·`id-token:write`만 가진 deploy job을 분리합니다. checkout credential은 보존하지 않으며 모든 official action은 full commit SHA로 고정됩니다. Dependabot이 GitHub Actions, npm lock, Python pin을 주기적으로 갱신합니다.

저장소 관리자가 GitHub UI에서 수동으로 설정해야 할 항목:

1. Pages source를 **GitHub Actions**로 선택
2. Dependency graph를 활성화한 저장소에서만 dependency review를 required check로 지정. 비활성 상태에서는 GitHub가 `Dependency review is not supported`로 실패합니다.
3. GitHub Advanced Security를 사용할 수 있다면 secret scanning과 push protection 활성화
4. `github-pages` environment에 필요한 reviewer/branch protection 적용
5. workflow가 요청하지 않은 write permission을 받지 않도록 default workflow permission을 read-only로 설정
6. 기존 owner-only portable compatibility에 사용하는 GitHub App은 이 저장소로만 한정하고, 이를 다른 저장소용 범용 인증 흐름으로 문서화하거나 Pages 앱에 포함하지 않기

## 7. 공용 기기와 브라우저 보안 한계

- session key 유지는 기본 해제입니다.
- public-device/capability mode에서는 service worker와 persistent cache를 사용하지 않는 흐름을 우선합니다.
- 앱의 종료 동작은 앱이 만든 memory key reference, storage, own Cache Storage, service worker registration, object URL, preview DOM, URL fragment만 정리할 수 있습니다.
- 앱은 브라우저 전체 방문 기록, 다운로드 기록, 운영체제 최근 파일, spooler·printer 기록을 지울 수 없습니다. UI나 문서에서 이를 지웠다고 주장하지 않습니다.
- HTML, SVG, XML은 inline preview하지 않습니다. 파일명은 text node로 렌더링하고 ZIP entry는 traversal path를 거부합니다.
- GitHub Pages는 임의의 CSP 외 HTTP response header를 설정할 수 없습니다. 더 강한 Permissions-Policy, framing policy, `X-Content-Type-Options`가 필요하면 header 제어가 가능한 별도 hosting이 필요합니다.

## 8. 알려진 제한

- backend가 없으므로 login attempt rate limit, 계정별 권한, server-enforced capability expiry/revocation을 제공하지 않습니다.
- 암호문은 공개되므로 약한 passphrase에 대한 offline guessing을 막을 수 없습니다.
- Git에서 현재 파일을 삭제해도 과거 commit은 남습니다. history 정화는 backup과 협업자 재동기화가 필요한 파괴적 작업이며 자동 실행하지 않습니다.
- ZIP 생성은 브라우저 메모리를 사용하므로 큰 파일·많은 파일에는 기기 한계가 있습니다.
- GitHub Pages의 기본 CDN cache와 배포 반영에는 지연이 있을 수 있습니다.
- `robots.txt`는 검색 엔진에 대한 요청일 뿐 접근 제어가 아닙니다.
