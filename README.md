# Print Drive

Print Drive는 중요한 파일을 장기 보관하는 Drive가 아니라, 프린트할 파일을 임시로 내려받기 위한 GitHub Pages 기반 파일 목록 페이지입니다.

이 버전은 백엔드 없이 가능한 보안을 최대한 끌어올리기 위해 **클라이언트 복호화 방식**을 사용합니다. GitHub Pages에 올라가는 `files/` 폴더에는 원본 파일이 아니라 암호화된 `.bin` 파일과 암호화된 `manifest.enc`만 들어갑니다.

## 보안 구조

- 원본 파일은 로컬 `private_files/`에만 둡니다.
- `private_files/`와 `.print-drive-passphrase`는 `.gitignore`로 제외됩니다.
- `node encrypt_files.mjs`가 원본 파일을 AES-256-GCM으로 암호화합니다.
- 파일명, 크기, 타입, 원본 해시 목록은 `manifest.enc` 안에 암호화됩니다.
- 웹 페이지에는 비밀번호나 비밀번호 해시가 들어가지 않습니다.
- 비밀번호 입력 후 브라우저 Web Crypto API가 PBKDF2-SHA256 키를 만들고 manifest와 파일을 복호화합니다.
- 외부 JS CDN을 쓰지 않습니다. ZIP 생성도 페이지 내부 코드가 직접 처리합니다.

## 첫 설정

1. 원본 파일을 `private_files/` 폴더에 넣습니다.
2. 강한 비밀번호를 직접 정하려면 아래 명령을 실행하고 입력합니다.

```powershell
node encrypt_files.mjs
```

자동으로 강한 로컬 비밀번호 파일을 만들려면 아래 명령을 실행합니다.

```powershell
node encrypt_files.mjs --init-passphrase
```

이 경우 `.print-drive-passphrase`가 생성됩니다. 이 파일은 Git에 올라가지 않습니다.

## 평소 사용법

1. `private_files/`에 프린트할 파일을 넣거나 교체합니다.
2. 암호화 파일을 갱신합니다.

```powershell
node encrypt_files.mjs
```

3. 변경된 `files/manifest.enc`와 `files/*.bin`을 GitHub Pages에 반영합니다.

```powershell
git add files/
git commit -m "Update encrypted print files"
git push
```

4. 페이지에서 같은 비밀번호를 입력하고 파일을 내려받습니다.

## 비밀번호 변경

가장 쉬운 방법:

```powershell
node set_password.mjs 0907
```

명령을 실행하면 `.print-drive-passphrase`가 바뀌고 `files/`의 암호화 결과도 새 비밀번호로 다시 생성됩니다. 배포하려면 이후 아래처럼 올립니다.

```powershell
git add files/
git commit -m "Update encrypted print files"
git push
```

## 자동 동기화

`auto_sync.py`는 `private_files/`와 `files/`를 감시합니다.

- `private_files/`가 바뀌고 `.print-drive-passphrase` 또는 `PRINT_DRIVE_PASSPHRASE`가 있으면 자동으로 `node encrypt_files.mjs`를 실행합니다.
- 그 뒤 `files/`의 암호화 결과만 commit/push합니다.
- 원격 브랜치가 앞서 있으면 자동 병합하지 않고 수동 `git pull --rebase` 확인을 안내합니다.

실행:

```powershell
python auto_sync.py
```

## 모바일 사용

- 비밀번호를 입력하면 같은 탭의 세션 동안 다시 묻지 않도록 유지할 수 있습니다.
- 이때 저장되는 것은 비밀번호 문자열이 아니라 복호화 키 바이트이며, `sessionStorage`에만 보관됩니다.
- `잠금` 버튼을 누르면 세션 키가 삭제됩니다.
- 파일명 검색, 타입 필터, 정렬, 선택 ZIP 다운로드를 사용할 수 있습니다.

## 파일명 권장 규칙

- 권장: `2026-06-05_회로과제.pdf`
- 권장: `프린트_자료_1.pdf`
- 비권장: `#`, `%`, `?` 같은 특수문자가 많은 파일명

원본 파일명은 암호화된 manifest 안에만 들어가므로 공개 저장소에는 노출되지 않습니다.

## 알려진 제한

- 백엔드가 없으므로 접속 시도 횟수 제한, 계정별 권한, 서버 로그 기반 차단은 할 수 없습니다.
- 비밀번호가 약하면 공격자가 공개 암호문을 내려받아 오프라인 추측 공격을 할 수 있습니다.
- 최소 12자 이상, 가능하면 긴 문장형 비밀번호를 사용하세요.
- 이미 Git에 커밋되어 공개된 평문 파일은 현재 파일을 지워도 Git 히스토리에 남을 수 있습니다.
- 과거 평문까지 없애려면 Git 히스토리 정화와 force push 또는 새 저장소 이전이 필요합니다.
- 암호화된 파일 크기는 64KB 단위 패딩 때문에 정확한 원본 크기보다 둔감하게 노출됩니다.
- GitHub Pages 반영은 보통 몇 초에서 수십 초 지연될 수 있습니다.
- 큰 파일이나 아주 많은 파일은 브라우저 복호화와 ZIP 생성이 느릴 수 있습니다.
- 원본 파일을 실수로 `files/`에 넣으면 공개될 수 있으니 반드시 `private_files/`를 사용하세요.
