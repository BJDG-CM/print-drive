# Print Drive

Print Drive는 프린트할 파일을 잠깐 내려받기 위한 GitHub Pages 기반 파일 목록 페이지입니다.

백엔드 없이 공개 저장소에 올릴 수 있도록 원본 파일은 로컬에만 두고, Pages에는 암호화된 `files/manifest.enc`와 `files/*.bin`만 배포합니다.

## 보안 구조

- 원본 파일은 로컬 `private_files/`에만 둡니다.
- `private_files/`, `.print-drive-passphrase`, `.tmp/`는 Git에서 제외됩니다.
- `node encrypt_files.mjs`가 원본 파일을 AES-256-GCM으로 암호화합니다.
- 파일명, 크기, 타입, 원본 해시는 암호화된 `manifest.enc` 안에만 들어갑니다.
- 웹 페이지에는 비밀번호나 비밀번호 해시가 들어가지 않습니다.
- 브라우저는 Web Crypto API로 PBKDF2-SHA256 키를 만들고 manifest와 파일을 복호화합니다.
- `files/`에는 `manifest.enc`, `.gitkeep`, 32자리 lowercase hex 이름의 `.bin` 파일만 허용됩니다.

## 첫 설정

1. 원본 파일을 `private_files/` 폴더에 넣습니다.
2. 비밀번호를 직접 입력해 암호화합니다.

```powershell
node encrypt_files.mjs
```

자동으로 강한 로컬 비밀번호 파일을 만들려면 아래 명령을 실행합니다.

```powershell
node encrypt_files.mjs --init-passphrase
```

이 경우 `.print-drive-passphrase`가 생성됩니다. 이 파일은 Git에 올라가지 않습니다.

## 평소 사용법

```powershell
node encrypt_files.mjs
git add files/
git commit -m "Update encrypted print files"
git push
```

GitHub Actions는 검사와 빌드를 실행한 뒤 `dist/`만 GitHub Pages artifact로 배포합니다.

## 비밀번호 변경

가장 안전한 방법은 숨김 입력입니다.

```powershell
node set_password.mjs
```

기본 정책:

- 12자 미만 비밀번호는 실패합니다.
- 숫자만 있는 비밀번호는 약한 비밀번호로 간주됩니다.
- 숫자만 있는 비밀번호는 `--allow-weak-password`를 쓰더라도 최소 8자리 이상이어야 합니다.
- CLI 인자로 비밀번호를 넘기는 기능은 기본 비활성화입니다.

정말 약한 비밀번호를 허용해야 할 때만 명시적으로 실행합니다.

```powershell
node set_password.mjs --allow-weak-password
```

쉘 히스토리 노출 위험을 감수하고 CLI 인자를 써야 할 때만 아래처럼 명시합니다.

```powershell
node set_password.mjs --allow-cli-password --allow-weak-password <password>
```

## 검증과 빌드

```powershell
npm run check
npm test
npm run build
```

- `npm run check`: `node --check`, `python -m py_compile`, public files leak guard를 실행합니다.
- `npm test`: 임시 파일을 암호화한 뒤 manifest와 파일 복호화 smoke test를 실행합니다.
- `npm run build`: Pages 배포용 `dist/`를 만듭니다.

`dist/`에는 아래 항목만 포함됩니다.

- `index.html`
- `manifest.json`
- `icon.svg`
- `robots.txt`
- `sw.js`
- `files/`

## 자동 동기화

필요한 Python 의존성을 설치합니다.

```powershell
python -m pip install -r requirements.txt
```

실행:

```powershell
python auto_sync.py
```

`auto_sync.py`는 `private_files/`와 `files/`를 감시합니다.

- `private_files/`가 바뀌고 `.print-drive-passphrase` 또는 `PRINT_DRIVE_PASSPHRASE`가 있으면 `node encrypt_files.mjs`를 실행합니다.
- 그 뒤 `files/`의 암호화 결과만 commit/push합니다.
- `node`, `git`, `watchdog`이 없으면 실행 초기에 명확한 오류를 출력합니다.
- 원격 브랜치가 앞서 있으면 자동 병합하지 않고 수동 `git pull --rebase` 확인을 안내합니다.

## 경로 설정

모든 기본 경로는 프로젝트 루트 기준입니다. 사용자가 다른 폴더에서 명령을 실행해도 스크립트 파일 위치를 기준으로 동작합니다.

환경변수로 경로를 바꿀 수 있습니다.

- `PRINT_DRIVE_ROOT`
- `PRINT_DRIVE_SOURCE_DIR`
- `PRINT_DRIVE_OUTPUT_DIR`
- `PRINT_DRIVE_PASSWORD_FILE`
- `PRINT_DRIVE_PASSPHRASE`

상대경로는 `PRINT_DRIVE_ROOT` 또는 기본 프로젝트 루트 기준으로 해석하고, 절대경로는 그대로 사용합니다.

예시:

```powershell
$env:PRINT_DRIVE_SOURCE_DIR = "private_files"
$env:PRINT_DRIVE_OUTPUT_DIR = "files"
node encrypt_files.mjs
```

## 모바일 사용

- 세션 키 유지는 기본 해제입니다.
- 체크박스 문구는 “공용 PC에서는 체크하지 마세요” 기준으로 안내합니다.
- 저장되는 것은 비밀번호 문자열이 아니라 복호화 키 바이트이며, `sessionStorage`에만 보관됩니다.
- 10분 동안 사용하지 않으면 자동 잠금됩니다.
- `잠금` 버튼을 누르면 세션 키가 삭제됩니다.
- 파일명 검색, 타입 필터, 정렬, 선택 ZIP 다운로드를 사용할 수 있습니다.

## 미리보기 제한

새 탭 미리보기는 안전한 표시용 타입만 허용합니다.

- 허용: `pdf`, `png`, `jpg`, `jpeg`, `webp`
- 다운로드만 허용: `svg`, `html`, `xml`, Office 문서, ZIP과 기타 압축 파일 등

## 파일명 권장 규칙

- 권장: `2026-06-05_회로과제.pdf`
- 권장: `프린트_자료_1.pdf`
- 비권장: `#`, `%`, `?` 같은 특수문자가 많은 파일명

원본 파일명은 암호화된 manifest 안에만 들어가므로 공개 저장소에는 노출되지 않습니다.

## 알려진 제한

- 백엔드가 없으므로 접속 시도 횟수 제한, 계정별 권한, 서버 로그 기반 차단은 할 수 없습니다.
- 비밀번호가 약하면 공격자가 공개 암호문을 내려받아 오프라인 추측 공격을 할 수 있습니다.
- 이미 Git에 커밋되어 공개된 평문 파일은 현재 파일을 지워도 Git 히스토리에 남을 수 있습니다.
- 과거 평문까지 없애려면 Git 히스토리 정화와 force push 또는 새 저장소 이전이 필요합니다.
- 암호화된 파일 크기는 64KB 단위 패딩 때문에 정확한 원본 크기보다 둔감하게 노출됩니다.
- GitHub Pages 반영은 보통 몇 초에서 수십 초 지연될 수 있습니다.
- 큰 파일이나 아주 많은 파일은 브라우저 복호화와 ZIP 생성이 느릴 수 있습니다.
