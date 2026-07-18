> [!IMPORTANT]
> **Imported design reference — not production behavior.** 이 문서는 `.tmp/claude-design-import-20260718`의 Claude 프로토타입 산출물을 2026-07-18에 기계적으로 가져온 참고 자료다. `Print Drive.dc.html`, `support.js`, React/DC runtime, prototype toolbar는 배포하지 않는다.
>
> 현재 통합은 vanilla `index.html` / `styles.css` / ES module 구조를 사용하며 기존 51개 DOM ID와 `.file-item[data-file-id]`, `.file-checkbox`, `[data-filter]` 계약을 유지한다. 원문에 적힌 “기존 ID 전부 제거”, “모든 target 44px 완료”, “modal 접근성 동작 완료” 같은 표현은 **가져온 프로토타입 자체에 대한 설명 또는 목표**이지 현재 runtime 기능 완료를 뜻하지 않는다. Capability 공유, public-device cleanup, typed error, modal focus trap, sync/deploy는 실제 코드와 test가 연결된 뒤에만 완료로 간주한다.

---

# Component Inventory — Print Drive

## Screens (15, incl. entry)

| Screen | Shell | Notes |
|---|---|---|
| 진입 선택 (mode-select) | standalone | new — splits public vs vault entry |
| 잠금 화면 (vault-lock) | standalone | idle/loading/invalid-password/network sub-states via demo toggle |
| 일회성 링크 진입 (limited-link) | standalone | gate step + focused file step (print-first, exit CTA) |
| 최근 파일 (recent-files) | vault | top 4 files, simplified controls (no search/filter) |
| 전체 파일 (all-files) | files-shell | search, sort, filter chips, selection mode |
| 검색 결과 없음 (no-results) | files-shell | list area swapped for empty-state panel |
| 빈 저장소 (empty-vault) | files-shell | list area swapped for empty-state panel |
| 파일 미리보기 (preview) | files-shell + modal | overlay on all-files |
| 미리보기 실패 (preview-error) | files-shell + modal | 3 cause variants (network/integrity/unsupported) |
| 관리자 파일 관리 (admin-files) | admin-shell | drop-zone style add, table with 교체/삭제 |
| 업로드·암호화·동기화 상태 (admin-status) | admin-shell | 6-step vertical status list + settings |
| 동기화 실패 (sync-error) | admin-shell | admin-status + persistent error panel + failed step |
| 공용 기기 종료 (public-exit) | standalone | confirm step → result step (cleaned vs. not-cleaned lists) |
| 만료된 링크 (expired-link) | standalone | disabled "새 링크 요청" (`data-prototype`) |
| 네트워크 오류 (network-error) | standalone | persistent panel, retry / back-to-lock |

Plus 3 modals: 관리자 모드 전환 확인, 공유 링크 생성, 파일 삭제 확인.

## Reusable component specs

**File row** (flat list item, used in recent/all/admin variants)
- Structure: [selection checkbox if selecting] · type badge (ext text, 40×40, `--primary-soft` bg) · name (2-line clamp, `overflow-wrap:anywhere`) + NEW badge + meta line · actions (미리보기·인쇄 primary / 다운로드 secondary / 다운로드-only if `previewable:false`).
- States: default, selected (bg tint), not-previewable (label instead of button).
- Keyboard: each row's interactive elements are native `<button>`/`<input type=checkbox>` — natural tab order, no custom key handling needed.

**Filter chip**: pill button, active = solid `--primary` bg + white text; inactive = `--surface-muted` bg + `--text-muted`. `aria-pressed` should be wired by Codex to the real filter state (see DOM_CHANGES).

**Status step row** (admin-status): title + description (real current-step text, never a fake %) + status chip (완료/진행 중/미배포/대기/실패), each chip pairs a text label with a background color — never color-only.

**Empty-state panel**: dashed border, centered, title + one-line explanation + 1-2 actions. Shared shape for no-results / empty-vault / (network-error uses a taller standalone variant with an icon).

**Modal** (preview / preview-error / admin-confirm / share-link / delete-confirm): centered panel, header (title + close), body, footer (secondary action(s) left, primary action right, close last). Backdrop click closes. Codex must wire real focus-trap/inert/Escape/opener-restore (design specifies the shape; behavior is `CODEX_TODO`).

**Toast**: bottom-right, border-left accent, used only for the non-critical "인쇄 창을 열었습니다" confirmation (auto-dismiss ~3.2s). Critical errors use persistent panels instead, per STATE_MATRIX.

## Design tokens (implemented as CSS custom properties, light/dark pairs)

Color: `--bg --surface --surface-muted --border --border-strong --text --text-muted --text-faint --primary --primary-hover --primary-soft --primary-soft-text --accent --accent-soft --accent-text --danger --danger-soft --danger-text --warning --warning-soft --warning-text --focus --admin-bar-bg --admin-bar-text --admin-bar-border --admin-accent`

Shadow: `--shadow-sm --shadow-md`. Radius: 8–14px (rows/buttons 9-10px, panels/modals 14-16px) — deliberately not pill-everything. Spacing scale: 4/6/8/10/12/14/16/18/20/22/24/32px, used directly (no spacing token names). Touch targets: 44×44px minimum on all interactive elements. Breakpoint: fluid (flex-wrap + clamp-able text) from 360–1440px; no hard breakpoint switch. Motion: 120–180ms ease for hover/press/modal-enter only; spinner uses a single linear rotation; no decorative motion.
