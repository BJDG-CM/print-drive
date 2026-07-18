# Print Drive 휴대형 업데이터

`PrintDrive-Portable-windows-x64.zip`은 Windows 10/11 x64에서 설치된 Node.js, Git, Python 없이 실행되는 관리자용 패키지다. `Workspace`의 평문을 로컬에서 암호화하고 GitHub에는 `files/manifest.enc`와 `files/<blob-id>.bin`만 전송한다. 평문, vault 비밀번호, GitHub token은 저장소나 설정 파일에 기록하지 않는다.

## 저장소 관리자 최초 설정

1. GitHub App을 만들고 **Device Flow**를 활성화한다. App을 대상 저장소에 설치하고 repository permissions를 `Contents: Read and write`, `Pull requests: Read and write`, 그 밖의 권한은 최소로 둔다.
2. 공개 값인 App client ID를 `print-drive.workspace.json`의 `oauthClientId`에 넣는다. client secret, token, 비밀번호는 이 파일에 넣지 않는다.
3. `owner`, `repo`, `branch`, `expectedVaultId`, `pagesUrl`을 실제 배포와 대조한다. `encryptedOutputPath`는 `files`로 유지한다.
4. Actions에서 `Build portable updater`를 수동 실행하거나 `portable-v*` tag를 push한다. 산출 ZIP과 `.sha256`을 함께 배포한다.
5. 조직 정책이 Device Flow 또는 GitHub App 설치를 막으면 fine-grained personal access token을 사용자가 UI에 직접 입력한다. 이 token에는 대상 저장소의 `Contents: Read and write`와, fallback PR이 필요하면 `Pull requests: Read and write`만 부여한다.

OAuth App도 Device Flow를 지원하지만, 저장소가 명확히 한정되는 GitHub App을 권장한다. client ID는 공개 식별자이며 client secret은 패키지에 포함하지 않는다.

## 사용자 절차

1. ZIP을 원하는 폴더에 풀고 `Workspace`에 추가·교체할 파일과 하위 폴더를 넣는다.
2. `PrintDriveUpdater.exe`를 실행한다. 업데이터는 임의 포트의 `127.0.0.1`에만 바인딩하고 256-bit 일회 세션 URL을 기본 브라우저로 연다.
3. vault 비밀번호와 모드를 선택하고 미리보기를 만든다. 기본 `추가/교체`는 원격 전용 파일을 보존한다. `선택 삭제`는 명시한 상대 경로만 지운다. `mirror`는 Workspace와 원격을 같게 만들며 빈 Workspace에서는 두 번째 확인이 필요하다.
4. Device Flow로 로그인한 뒤 추가·교체·이동·삭제 계획과 기준 commit SHA를 확인하고 적용한다.
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

## 보안 경계

- 로컬 서버는 loopback만 수락하고 Host, 세션 query token, 변경 요청의 CSRF token을 검증한다.
- 세션·CSRF·Device token은 매 실행마다 생성하거나 메모리에만 보관하고 성공·종료 때 참조를 제거한다.
- Content Security Policy와 `no-store`를 적용한다. 오류에서 GitHub token 형식을 마스킹한다.
- 실행 중인 프로세스, 브라우저, OS, 보안 제품이 메모리를 검사하는 위험까지 제거하지는 못한다. 신뢰할 수 있는 관리자 PC에서만 사용하고 완료 뒤 브라우저와 실행 파일을 닫는다.
- 패키지 서명은 현재 자동화하지 않는다. 배포 전 `.sha256`을 별도 신뢰 채널로 확인하고, 조직이 요구하면 Authenticode 서명을 추가한다.
