# Print Drive 휴대형 업데이터

`PrintDrive-Portable-windows-x64.zip`은 Windows 10/11 x64에서 설치된 Node.js, Git, Python 없이 실행되는 관리자용 패키지다. `Workspace`의 평문을 로컬에서 암호화하고 GitHub에는 `files/manifest.enc`와 `files/<blob-id>.bin`만 전송한다. 평문, vault 비밀번호, GitHub token은 저장소나 설정 파일에 기록하지 않는다.

## 가장 빠른 사용 방법

1. [Windows용 ZIP](https://github.com/BJDG-CM/print-drive/releases/latest/download/PrintDrive-Portable-windows-x64.zip)과 [SHA-256 파일](https://github.com/BJDG-CM/print-drive/releases/latest/download/PrintDrive-Portable-windows-x64.zip.sha256)을 같은 폴더에 받는다.
2. PowerShell에서 `Get-FileHash .\PrintDrive-Portable-windows-x64.zip -Algorithm SHA256` 결과가 sidecar의 값과 같은지 확인한다.
3. ZIP을 풀고 `PrintDrive-Portable.exe`를 실행한다. Windows x64용이며 코드 서명이 없으므로 조직 정책이나 SmartScreen이 경고할 수 있다.
4. 기본 `Workspace`를 열어 평문을 넣거나 **다른 폴더 선택**으로 기존 원본 폴더를 지정한다. 선택 경로는 저장하지 않는다.
5. Fine-grained token을 검증하고 vault 비밀번호를 입력해 계획을 만든 뒤, 기준 commit·변경 수·암호화 업로드 크기를 확인하고 적용한다.

Fine-grained token은 `Only select repositories → BJDG-CM/print-drive`, `Contents: Read and write`, `Metadata: Read`로 제한한다. 브랜치 보호 fallback PR까지 만들려면 `Pull requests: Read and write`도 필요하다. token과 비밀번호는 설정·URL·로그에 기록하지 않고 프로세스 메모리에서만 사용한다.

## 선택 사항: 저장소 관리자 Device Flow 설정

1. GitHub App을 만들고 **Device Flow**를 활성화한다. App을 대상 저장소에 설치하고 repository permissions를 `Contents: Read and write`, `Pull requests: Read and write`, 그 밖의 권한은 최소로 둔다.
2. 공개 값인 App client ID를 `print-drive.workspace.json`의 `oauthClientId`에 넣는다. client secret, token, 비밀번호는 이 파일에 넣지 않는다.
3. `owner`, `repo`, `branch`, `expectedVaultId`, `pagesUrl`을 실제 배포와 대조한다. `encryptedOutputPath`는 `files`로 유지한다.
4. Actions에서 `Build portable updater`를 수동 실행하거나 `portable-v*` tag를 push한다. 산출 ZIP과 `.sha256`을 함께 배포한다.
5. `oauthClientId`가 비어 있어도 fine-grained token 경로로 모든 기본 작업을 수행할 수 있다. Device Flow는 선택 사항이다.

OAuth App도 Device Flow를 지원하지만, 저장소가 명확히 한정되는 GitHub App을 권장한다. client ID는 공개 식별자이며 client secret은 패키지에 포함하지 않는다.

## 사용자 절차

1. ZIP을 원하는 폴더에 풀고 `Workspace`에 추가·교체할 파일과 하위 폴더를 넣거나 다른 원본 폴더를 선택한다.
2. `PrintDrive-Portable.exe`를 실행한다. 업데이터는 임의 포트의 `127.0.0.1`에만 바인딩하고 256-bit 일회 세션 URL을 기본 브라우저로 연다.
3. vault 비밀번호와 모드를 선택하고 미리보기를 만든다. 기본 `추가/교체`는 원격 전용 파일을 보존한다. `선택 삭제`는 명시한 상대 경로만 지운다. `mirror`는 Workspace와 원격을 같게 만들며 빈 Workspace에서는 두 번째 확인이 필요하다.
4. Fine-grained token(기본) 또는 설정된 Device Flow로 로그인한 뒤 추가·교체·이동·삭제·변경 없음 계획과 기준 commit SHA를 확인하고 적용한다.
5. 업데이터는 적용 직전 branch ref를 다시 읽는다. 기준 SHA가 달라졌으면 원격을 바꾸지 않고 새 미리보기를 요구한다.

## 원격 적용과 복구

업데이터는 정확히 하나의 commit/tree snapshot을 가져온 뒤 새 암호화 blob을 올리고, stale object 삭제를 포함한 하나의 tree와 commit을 만든다. 마지막 ref update는 `force: false`다. 업로드나 tree/commit 생성 중 실패하면 branch ref는 그대로이며 도달 불가능한 Git object만 남을 수 있다.

보호 규칙이 직접 ref update를 거절하면 생성된 commit을 임시 `print-drive-update/*` branch에 연결하고 PR을 만드는 fallback을 제공한다. 이 상태는 **배포 완료가 아니다**. PR 검증과 merge, Pages 배포 확인이 필요하다. 동시 변경 충돌은 자동 병합하지 않고 새 snapshot부터 다시 시작한다.

GitHub 일반 Git blob 한도에 맞춰 암호화 결과 하나가 100 MiB를 넘으면 원격 변경 전에 중단한다. 조직의 실행 파일 정책, App 승인, SSO, IP allow list, branch rules는 관리자가 별도로 허용해야 한다.

## 빌드와 검증

Windows x64, Node 24 환경에서 다음을 실행한다.

```powershell
npm ci --ignore-scripts
npm run portable:build
npm run portable:test
```

빌드는 Node SEA 실행 파일, 기본 설정, 빈 Workspace, 안내문을 하나의 ZIP으로 만들고 SHA-256 sidecar를 생성한다. native smoke test는 PATH를 비운 채 ZIP 속 실행 파일을 시작해 UI asset 로딩과 실제 AES-GCM 암복호화 cycle을 확인한다. Actions는 모든 third-party action을 full commit SHA로 고정한다.

실제 GitHub 쓰기 경로 검증은 일반 CI에서 실행하지 않는다. 별도의 일회용 브랜치 이름과 자격 증명을 명시한 경우에만 다음 opt-in 검사를 실행한다.

```powershell
$env:PRINT_DRIVE_INTEGRATION_TOKEN = '<fine-grained token>'
$env:PRINT_DRIVE_INTEGRATION_REPO = 'BJDG-CM/print-drive'
$env:PRINT_DRIVE_INTEGRATION_BRANCH = 'print-drive-integration/manual-check'
$env:PRINT_DRIVE_INTEGRATION_PASSPHRASE = '<vault passphrase>'
npm run integration:github
```

검사는 `main`을 거부하고 새 전용 브랜치가 이미 있으면 재사용하지 않는다. 정확한 원격 vault snapshot에서 중첩 파일을 암호화해 원자 commit을 적용하고, 다시 내려받아 schema 3·상대 경로·평문 일치를 확인한 후 branch를 삭제한다. 정리에 실패하면 수동으로 지워야 할 정확한 branch 이름을 출력한다. token과 passphrase는 출력하지 않는다.

## 보안 경계

- 로컬 서버는 loopback만 수락하고 Host, 세션 query token, 변경 요청의 CSRF token을 검증한다.
- 세션·CSRF·Device token은 매 실행마다 생성하거나 메모리에만 보관하고 성공·종료 때 참조를 제거한다.
- Content Security Policy와 `no-store`를 적용한다. 오류에서 GitHub token 형식을 마스킹한다.
- 실행 중인 프로세스, 브라우저, OS, 보안 제품이 메모리를 검사하는 위험까지 제거하지는 못한다. 신뢰할 수 있는 관리자 PC에서만 사용하고 완료 뒤 브라우저와 실행 파일을 닫는다.
- 패키지 서명은 현재 자동화하지 않는다. 배포 전 `.sha256`을 별도 신뢰 채널로 확인하고, 조직이 요구하면 Authenticode 서명을 추가한다.

## 기존 원본 폴더 복구

저장소 clone에서 `Repair-PrintDrive.cmd`를 실행한다. 런처는 Git·Node.js·Python을 확인하고 `origin/main`과의 ahead/behind/diverged 상태를 검사하며, 안전한 fast-forward만 허용한다. 선택한 폴더에 대해 먼저 dry-run 분류를 출력한 뒤 `adopt`, `add-replace`, `mirror` 중 사용자가 고르게 한다. `mirror`는 자동 선택되지 않으며 원격 전용 삭제 목록을 검토하고 `DELETE_REMOTE_ONLY`를 정확히 입력해야만 실행된다. 마지막 `npm run verify`가 실패하면 push하지 않는다.
