# Claude Design Brief

## 제품 한 문장

Print Drive는 신뢰 기기에서 준비한 파일을 공용 PC에서 빠르게 찾아 열고 인쇄하되, 공개 배포본에는 평문 파일명과 평문 원본을 두지 않는 개인용 파일 전달 서비스다.

## 핵심 사용자와 맥락

디자인은 다음 세 맥락을 섞지 않는다.

1. **공용 기기 사용자**: 제한 공유 링크로 지정 파일만 열고 인쇄한 뒤 앱이 관리하는 흔적을 정리한다.
2. **신뢰 기기 vault 사용자**: 전체 비밀번호로 보관함을 열어 검색·미리보기·다운로드·공유 준비를 한다.
3. **관리자**: 로컬 원본을 검토하고 암호화·sync·배포 상태를 관리한다. 현재 브라우저 기능은 update ZIP 생성까지만 가능하다.

## 핵심 시나리오

### A. 공용 PC에서 인쇄

제한 링크 열기 → 링크 검증 → 한정된 파일 표시 → preview 또는 인쇄창 열기 → `공용 기기 사용 종료` → 앱이 정리한 것과 정리할 수 없는 것을 안내.

### B. 신뢰 기기에서 전체 vault 사용

전체 보관함 잠금 해제 → 검색/필터/정렬 → preview/download/선택 ZIP → 명시적 잠금.

### C. 신뢰 기기에서 파일 갱신

관리자 panel 진입 → 파일 선택/충돌 검토 → 암호화 진행 → `update ZIP 생성됨 · 아직 미배포` 또는 localhost agent sync → push → Pages 배포 확인 대기 → 실제 artifact 확인.

## 필수 화면과 상태

- 진입 선택: 제한 공유 링크와 전체 vault unlock의 차이를 분명히 표시
- 전체 vault 잠금 및 단계별 loading/error
- 파일 탐색: 검색, sort, filter, result/total, file cards
- preview/print dialog와 preview failure
- selection action bar와 ZIP progress/cancel
- 공용 기기 종료 확인과 수동 정리 checklist
- 신뢰 기기 관리자 panel: update 준비, 충돌, encryption, sync, deploy pending/error
- expired/invalid limited-share link
- empty list, no search results, persistent error

문구와 동작은 `STATE_MATRIX.md`, 기존 hook은 `DOM_CONTRACT.md`를 따른다.

## 디자인 원칙

1. **인쇄 우선**: 검색 → 파일 확인 → 인쇄창 열기가 첫 화면의 주 경로다.
2. **맥락 분리**: 공용 기기, 전체 vault, 관리자 기능의 권한과 위험을 시각적으로 구분한다.
3. **진실한 상태**: download 요청, ZIP 생성, Git push, Pages 배포 완료를 서로 다른 상태로 표현한다.
4. **종료 우선**: 공용 mode에서는 설치보다 `사용 종료`가 가장 강한 행동이다.
5. **복구 가능성**: 오류에는 원인 범위, 보존된 상태, 다음 행동을 지속적으로 보여준다.
6. **키보드·mobile 동등성**: 390px에서도 44×44px target, 긴 이름, full-screen viewer, focus 복귀가 유지돼야 한다.
7. **시스템 theme 존중**: light/dark를 모두 설계하고 dark primary 대비를 WCAG AA 수준으로 맞춘다. reduced motion도 제공한다.

## 기술 제약

- 현재 배포는 backend 없는 GitHub Pages다.
- HTML/CSS/vanilla JS이며 build가 CSS와 ES module을 한 HTML에 인라인한다.
- build는 정확한 `<link rel="stylesheet" href="styles.css">`와 `<script type="module" src="app.js">` anchor를 문자열 치환한다. 새 design asset은 `dist` allowlist와 bundler를 함께 수정해야 하며 non-relative browser import는 현재 거부된다.
- 파일 목록과 상태 item은 `app.js` runtime renderer가 생성한다. 정적 카드 시안만 제공하면 실제 앱에 연결되지 않는다.
- 정적 DOM ID 51개가 eager lookup된다. ID/element type 변경은 adapter가 필요하다.
- filter logical values: `all`, `pdf`, `image`, `document`, `other`.
- sort logical values: `recent`, `name`, `size`, `extension`, `api`.
- preview는 PDF, png/jpg/jpeg/webp, txt/csv/md만 허용한다. HTML/SVG/XML/Office/archive는 직접 렌더링하지 않는다.
- 브라우저는 파일을 한 번에 memory로 복호화하고 ZIP은 전체 평문을 memory에 모은다. 실제 progress·cancel 범위보다 강하게 표현하지 않는다.
- 현재 dark mode는 `prefers-color-scheme` 기반이며 manual toggle state는 없다.
- GitHub Pages에서는 CSP 등 일부 HTTP response header를 설정할 수 없다. meta CSP와 별도 hosting 필요 사항을 구분한다.

## 보안상 금지할 허위 표현

- 현재 `#file=<id>` QR을 **제한 공유**, **암호화 key 공유**, **만료 링크**라고 부르지 않는다. 지금은 전체 잠금 해제가 필요한 파일 위치 링크다.
- update ZIP 생성을 **업로드**, **sync**, **배포 완료**라고 부르지 않는다.
- `window.print()` 호출을 **인쇄 완료**라고 부르지 않는다.
- browser download 요청을 **파일 저장 완료**라고 부르지 않는다.
- 앱 잠금을 **방문 기록 삭제**, **다운로드 기록 삭제**, **최근 파일 삭제**, **프린터 기록 삭제**라고 부르지 않는다.
- 정적 링크에 server-enforced 만료·횟수 제한이 있다고 표현하지 않는다.
- 현재 배포 artifact의 allowlist 검사를 과거 Git history의 평문 제거 보장으로 확장하지 않는다.
- `완벽히 안전`, `흔적 없음`, `취약점 없음` 같은 절대 표현을 사용하지 않는다.

권장 현재 문구:

- `파일 위치 링크 · 전체 보관함 잠금 해제 필요`
- `관리자용 암호화 업데이트 ZIP 만들기`
- `ZIP 생성됨 · 아직 업로드되거나 배포되지 않음`
- `인쇄 창을 열었습니다`
- `Print Drive가 관리하는 세션 데이터와 미리보기를 정리했습니다`

## 디자인 산출물 요구사항

1. 1440×900, 1024×768, 390×844의 light/dark 주요 화면.
2. 공용 기기, 전체 vault, 관리자 맥락별 screen map.
3. `STATE_MATRIX.md` 16개 상태의 화면 또는 component state.
4. runtime file card, empty/no-result/error, progress, toast, modal의 component spec.
5. keyboard 순서, modal initial focus/trap/restore, screen-reader label과 live region 명세.
6. loading, disabled, cancelable/non-cancelable, offline, agent disconnected 상태.
7. copy deck. 특히 upload/sync/deploy/print/cleanup의 완료 범위를 명시.
8. 기존 DOM ID를 유지한 markup 또는 `DOM_CONTRACT.md` 기준 ID-to-new-component adapter 표.
9. icon, color, typography, spacing, breakpoint, truncation, touch-target token.
10. 디자인 변경이 필요한 이유와 Codex 후속 기능을 구분한 주석.

## Claude가 구현하지 않고 Codex에 넘길 것

- 암호 포맷, KDF, key hierarchy, v1→v2 migration, password rotation
- 증분 암호화, fingerprint, immutable blob, transactional output
- filesystem watcher, config/schema/path validation, Git commit/push, Pages 확인
- limited-share capability key 생성/해석과 URL fragment 정리
- public-device storage/cache/service-worker cleanup
- localhost agent authentication과 remote-upload backend interface
- strict manifest validation, CSP/security policy, preview sandbox, ZIP path validation
- runtime DOM adapter, focus manager, progress/error state machine
- unit/integration/E2E/accessibility/security/performance test와 CI

구체적 후속 목록은 `CODEX_TODO_AFTER_DESIGN.md`를 따른다.
