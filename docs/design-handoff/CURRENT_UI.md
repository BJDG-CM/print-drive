# Print Drive 현재 UI

## 조사 기준

- 기준 소스: `4c73eb0` (`main`에서 `codex/design-prep` 분기)
- 조사일: 2026-07-17
- 앱 형태: 빌드 단계에서 CSS와 ES module을 `dist/index.html`에 인라인하는 GitHub Pages 정적 앱
- 안전한 화면 fixture: `npm run design:fixture`가 `.tmp/design-fixture/`에 합성 파일 8개를 생성한다. 사용자 원본 폴더와 실제 비밀번호는 읽지 않는다.
- 화면 확인: 1440×900, 1024×768, 390×844 및 390×844 텍스트 미리보기. 캡처 당시 OS dark mode가 적용됐다.

## 현재 화면 구조

```text
body
├─ 전역 toast live region
├─ main.container
│  ├─ 잠금 화면
│  │  └─ 비밀번호, 잠금 해제, 탭 세션 유지, 오류
│  ├─ 초기 로딩 화면
│  └─ 잠금 해제 후 앱
│     ├─ 작업 차단 overlay와 ZIP 취소
│     ├─ header: 설치, 현재 페이지 QR, 새로고침, 잠금
│     ├─ 검색, 정렬, 타입 필터
│     ├─ 파일/결과 요약, 전체 ZIP, 선택 모드
│     ├─ 관리자성 "파일 추가" 영역
│     ├─ 선택 작업 bar
│     └─ 동적으로 생성되는 파일 목록 또는 빈/오류 상태
├─ 미리보기 modal
└─ QR modal
```

파일 카드, 빈 상태, 검색 결과 없음, 목록 오류, preview body는 `index.html`에 고정된 컴포넌트가 아니다. `app.js`가 매번 DOM을 다시 생성하므로 Claude가 정적 카드만 바꾸면 실제 목록에는 반영되지 않는다.

## 현재 사용자 흐름

| 흐름 | 실제 동작 | 현재 한계 |
|---|---|---|
| 잠금 해제 | `manifest.enc` fetch → PBKDF2-SHA256 → AES-GCM manifest 복호화 → 목록 표시 | KDF 시작 overlay가 숨겨진 `app-view` 안에 있어 느린 기기에서 초기 진행이 보이지 않는다. 비밀번호, 네트워크, 형식 오류가 같은 문구로 합쳐진다. |
| 세션 유지 | 선택 시 raw 복호화 key bytes를 현재 탭의 `sessionStorage`에 저장 | 공용 기기 전용 모드는 없고 service worker는 항상 등록된다. |
| 검색·필터·정렬 | 이름 포함 검색, 최근/이름/크기/확장자/API 정렬, PDF/이미지/문서/기타 필터 | `기타`에 archive도 포함된다. 검색 input은 placeholder 외 명시 label이 없다. |
| 단일 파일 | 암호문 fetch → AES-GCM 복호화 → SHA-256 확인 → 미리보기 또는 다운로드 | byte progress/cancel이 없다. 미리보기 실패 원인이 network/decrypt/render로 구분되지 않는다. |
| 미리보기·인쇄 | PDF iframe, image, txt/csv/md만 표시. modal 안에서 인쇄창을 연다. | focus trap/background inert/opener focus 복귀가 없다. “인쇄 완료”를 확인할 수 없다. |
| 선택 ZIP·전체 ZIP | 파일을 순차 복호화한 뒤 모든 평문 bytes를 메모리에 모아 무압축 ZIP 생성 | 큰 작업 메모리 상한이 없고 취소는 파일 사이에서만 확인한다. ZIP64 미지원. |
| 파일 추가 | 새 파일을 현재 vault key로 암호화해 update ZIP을 다운로드 | upload, sync, deploy가 아니다. 같은 이름의 이전 blob 삭제 지시도 없어 수동 덮어쓰기 시 stale blob이 남을 수 있다. |
| QR | 페이지 URL 또는 `#file=<id>` 위치 링크를 canvas로 생성 | 파일 key가 없는 위치 링크다. 상대도 전체 vault 비밀번호가 필요하며 만료 기능이 없다. deep link는 파일을 눈에 띄게 열지 않는다. |
| 잠금 | memory key, 목록, 선택, sessionStorage, preview object URL을 정리 | 공용 기기 종료가 아니며 Cache Storage, service worker, 다운로드·방문·프린터 기록을 정리하지 않는다. |
| PWA | install prompt를 지원하고 shell을 service worker cache에 저장 | 공용 기기에서도 등록된다. 수동 theme toggle은 없고 system dark mode만 따른다. |

## 현재 기능 목록

- AES-GCM manifest/file 복호화와 SHA-256 평문 검증
- 탭 단위 세션 유지 선택 및 10분 idle lock
- 이름 검색, 5개 정렬 모드, 5개 타입 chip
- 파일별 미리보기·다운로드·위치 QR
- 선택 모드, shift 범위 선택, 선택/전체 ZIP
- 브라우저 내 암호화 update ZIP 생성
- 빈 목록, 검색 결과 없음, 목록 오류, preview fallback, toast
- PDF/일부 image/text만 허용하는 preview allowlist
- object URL revoke, 텍스트 preview의 `textContent` 사용
- 640px mobile breakpoint, 긴 이름 2줄 처리, mobile full-screen modal
- `prefers-color-scheme` 기반 dark mode, PWA manifest와 service worker

## 실행 검증에서 확인한 동작

- 합성 vault에서 잠금 → 잘못된 비밀번호 → 정상 잠금 해제 → 8개 파일 목록 → 검색 → PDF filter → 이름순 sort → 텍스트 preview → 선택 ZIP 준비 상태까지 확인했다.
- 390×844에서 가로 overflow는 없었지만 header가 조밀하고 일부 target은 44px보다 작다.
- service worker가 shell을 cache하므로 server 중단 후에도 잠금 화면은 표시됐다. 이 상태에서 unlock하면 실제 원인은 manifest network 실패인데 UI는 잘못된 비밀번호와 같은 오류를 표시했다.
- 기존 test는 crypto smoke 1건이며 browser E2E, accessibility, offline/error taxonomy test는 없다.
- controlled fixture에서 `dist/files`에 허용 형식의 stale blob을 심은 뒤 build/check를 다시 실행해도 blob이 남고 검사가 통과했다. 이는 구현 모드의 artifact reference 검사가 필요함을 확인한다.

## UX 문제 분류

우선순위: **P0** 디자인 승인 전에 방향이 고정돼야 함, **P1** 실제 통합 전에 해결, **P2** 품질 개선.

| 분류 | 현재 동작 | 사용자 영향 | Claude Design이 해결할 부분 | Codex가 기능으로 해결할 부분 | 우선순위 |
|---|---|---|---|---|---|
| 핵심 흐름 | 공용 PC에서도 전체 vault 비밀번호를 입력한다. | master password 노출 위험이 핵심 목표와 충돌한다. | `제한 공유 링크`와 `전체 보관함` 진입을 분리한다. | 선택 파일 key만 전달하는 capability flow를 구현한다. | P0 |
| 핵심 흐름 | 인쇄는 preview modal 안의 2차 행동이다. | 찾고 바로 인쇄하는 목적보다 탐색 단계가 늘어난다. | preview 가능 파일의 `열기·인쇄`를 주 행동으로 설계한다. | 인쇄창 호출과 실제 완료를 구분하고 종료 안내를 연결한다. | P1 |
| 정보 구조 | 검색/목록과 관리자용 update ZIP이 한 화면에 섞인다. | 일반 사용자와 관리자 작업이 경쟁하며 권한 경계처럼 보이지 않는다. | 신뢰 기기 관리자 panel을 별도 맥락으로 분리한다. | localhost agent/capability 상태에 따라 노출한다. | P0 |
| 시각 위계 | install/QR/refresh/lock이 같은 무게이고 관리 영역이 목록 위에 있다. | 공용 PC의 가장 중요한 `사용 종료`가 묻힌다. | 파일 찾기·인쇄를 1차, bulk/admin을 2차로 둔다. | 공용 mode에서 설치/관리 기능을 숨기고 종료를 강조한다. | P0 |
| 공용 PC | 현재는 `잠금`만 있고 SW가 항상 등록된다. | 앱이 관리하지 못하는 흔적까지 지웠다고 오해할 수 있다. | 잠금과 `공용 기기 사용 종료`를 분리하고 한계를 표시한다. | 앱 storage/cache/SW/object URL/fragment만 실제로 정리한다. | P0 |
| 공용 PC | 인쇄창/다운로드 요청 뒤 후속 안내가 없다. | 저장·인쇄 성공과 잔여 흔적을 사용자가 판단하기 어렵다. | `인쇄 창을 열었습니다`와 수동 정리 checklist를 제공한다. | 제어 가능한 데이터만 정리하고 OS/browser 기록은 불가로 남긴다. | P0 |
| 관리자 | “파일 추가”는 update ZIP 다운로드일 뿐이다. | 이미 업로드·배포된 것으로 오해할 수 있다. | `업데이트 ZIP 만들기 · 아직 미배포` 단계로 표현한다. | 검토/충돌/제한/검증과 실제 agent 연동을 구현한다. | P0 |
| 관리자 | sync/push 상태는 `auto_sync.py` terminal에만 있다. | 웹 UI가 배포 상태를 사실대로 알 수 없다. | 미연결/암호화/push/배포 대기를 서로 다른 상태로 설계한다. | 인증된 상태 API와 GitHub 배포 확인이 있을 때만 상태를 제공한다. | P1 |
| 모바일 | 기본 44px 규칙보다 작은 34~42px target이 specificity로 남는다. | 이동 중 오조작 가능성이 커진다. | 모든 interaction target을 최소 44×44px로 설계한다. | responsive CSS와 E2E로 실제 크기를 검증한다. | P1 |
| 모바일 | 카드와 full-screen modal 토대는 있으나 관리자 영역이 세로 공간을 차지한다. | 첫 파일 도달이 늦고 긴 목록 효율이 떨어진다. | 관리자 영역 분리와 sticky action의 필요성을 검토한다. | 390×844, keyboard, 긴 이름 회귀 테스트를 추가한다. | P2 |
| 접근성 | modal semantics는 있으나 focus trap/inert/focus restoration이 없다. | keyboard·screen reader 사용자가 위치를 잃을 수 있다. | 초기 focus, 닫기, 복귀 위치를 명시한다. | focus manager와 background inert를 구현한다. | P1 |
| 접근성 | search label, error 연결, live loading, reduced motion이 부족하다. | 입력 목적·오류·진행이 보조기기에 안정적으로 전달되지 않는다. | 보이는 label과 지속 오류/status 영역을 포함한다. | ARIA state와 reduced-motion CSS를 연결한다. | P1 |
| 접근성 | dark primary `#60a5fa` 위 흰 글자는 약 2.54:1이다. | 일반 텍스트 대비가 부족하다. | dark palette의 primary/foreground 조합을 바꾼다. | 자동 contrast 검사를 추가한다. | P1 |
| 오류 | unlock 오류와 preview 오류가 각각 하나의 generic 원인으로 합쳐진다. | 사용자가 잘못된 비밀번호·network·손상을 구분하지 못한다. | 원인별 화면과 다음 행동을 설계한다. | typed error taxonomy와 retry 가능 조건을 구현한다. | P1 |
| 오류 | 중요한 오류도 3.2초 toast로 사라지고 404는 관리자 설정을 노출한다. | 공용 사용자가 복구 행동을 잃고 내부 운영 문구를 본다. | 지속 error panel과 사용자/관리자 진단 분리를 설계한다. | 오류 code, retry/back/lock action을 연결한다. | P1 |
| 보안 표현 | “QR 공유”, “파일 추가”, “공개 저장소에는 암호화된 파일만”이 범위보다 강하다. | 제한 공유·실제 upload·과거 Git history 안전까지 암시할 수 있다. | 현재 능력에 맞는 제한된 문구를 사용한다. | capability/upload/history 검사가 실제 구현된 뒤에만 강한 표현을 허용한다. | P0 |
| 성능 상태 | 초기 KDF 진행이 보이지 않고 single download는 byte progress가 없다. | 느린 기기에서 멈춘 것처럼 보인다. | 실제 단계와 취소 가능 여부를 구분한다. | 단계별 event, AbortController, 크기 상한을 구현한다. | P1 |

## 디자인 시 반드시 유지할 기능

1. 비밀번호 입력 label, 세션 유지 기본 off, 명시적 잠금과 idle lock.
2. 검색, sort value, filter value, 결과 수, empty/search-empty/error 상태.
3. 파일별 preview/download와 안전한 preview allowlist.
4. 선택 mode, selected count, 선택/전체 ZIP, ZIP cancel 상태.
5. update ZIP 기능은 관리자 맥락으로 이동해도 실제 동작과 `미배포` 의미를 유지.
6. mobile 긴 파일명, keyboard 조작, system dark mode, reduced-motion 추가 여지.
7. preview/QR modal의 title, body, actions, safe close와 object URL 정리.
8. 51개 DOM hook 또는 동등한 adapter. 상세는 `DOM_CONTRACT.md` 참조.

## 화면 캡처

- [1440×900](screenshots/current-ui-1440x900.png)
- [1024×768](screenshots/current-ui-1024x768.png)
- [390×844](screenshots/current-ui-390x844.png)
- [390×844 텍스트 미리보기](screenshots/preview-mobile-390x844.png)
- [390×844 잘못된 비밀번호](screenshots/invalid-password-mobile-390x844.png)
