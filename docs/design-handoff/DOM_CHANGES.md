> [!IMPORTANT]
> **Imported design reference — not production behavior.** 이 문서는 `.tmp/claude-design-import-20260718`의 Claude 프로토타입 산출물을 2026-07-18에 기계적으로 가져온 참고 자료다. `Print Drive.dc.html`, `support.js`, React/DC runtime, prototype toolbar는 배포하지 않는다.
>
> 현재 통합은 vanilla `index.html` / `styles.css` / ES module 구조를 사용하며 기존 51개 DOM ID와 `.file-item[data-file-id]`, `.file-checkbox`, `[data-filter]` 계약을 유지한다. 원문에 적힌 “기존 ID 전부 제거”, “모든 target 44px 완료”, “modal 접근성 동작 완료” 같은 표현은 **가져온 프로토타입 자체에 대한 설명 또는 목표**이지 현재 runtime 기능 완료를 뜻하지 않는다. Capability 공유, public-device cleanup, typed error, modal focus trap, sync/deploy는 실제 코드와 test가 연결된 뒤에만 완료로 간주한다.

---

# DOM Changes — Print Drive redesign vs. `DOM_CONTRACT.md`

`Print Drive.dc.html` is a from-scratch prototype (new markup structure, React-driven state), not an edit of `index.html`/`app.js`. **None of the original 51 static IDs are present as-is.** This table maps every ID in `DOM_CONTRACT.md` to where its function now lives in the new design and what Codex must build to connect it. Codex should treat this as the adapter spec required by `DOM_CONTRACT.md` §"Claude 산출물 통합 규칙".

## Removed IDs (all 51) → new location / adapter needed

| Old ID | New location in redesign | Adapter Codex needs |
|---|---|---|
| `toast-root` | bottom-right toast (print-confirmation only) | Portal target + live-region; keep `aria-live=polite` |
| `auth-view` | vault-lock screen | Screen/view-state controller (screen enum instead of `hidden` toggling) |
| `password-form` | `<form>` in vault-lock | Native form + submit handler |
| `password-input` | `#pw-input` in vault-lock | value/focus/select/clear bindings |
| `auth-submit` | 잠금 해제 submit button | disabled-during-loading binding |
| `remember-session` | checkbox in vault-lock | checked-state binding, default off preserved |
| `auth-error` | `#pw-error` (`role=alert`, `aria-describedby`) | error-text renderer, `aria-invalid` binding |
| `loading-view` | vault-lock loading overlay (staged text) | stage-event → text binding |
| `app-view` / `.selection-mode` | files-shell root + `selectionMode` boolean | view-state + selection-state controller |
| `global-loader` | (not yet built as global overlay — currently per-screen) | **Codex/Claude follow-up:** add one operation-overlay component reused by refresh/ZIP/upload; design shape = vault-lock loading overlay |
| `loading-message` | staged text inside loading overlay | operation-status text binding |
| `btn-cancel-zip` | **not yet in this pass** — selection action bar has 선택 ZIP but no in-flight cancel affordance | Codex/Claude follow-up: add cancel button to a ZIP-progress state |
| `btn-install` | removed from primary header; not present in this pass | Recommend: move to a "더보기" menu in vault header (stub exists, empty) |
| `btn-page-qr` | replaced conceptually by 관리자 "공유 링크 만들기" modal | capability-based share, not current-page QR |
| `btn-refresh` | not present in this pass | Recommend: add into vault header "더보기" menu |
| `btn-lock` | lock icon button, vault-shell header (all-files/recent-files) | lock action binding |
| `search-input` | `#search-input` (all-files), visible sr-only label added | query-state + input-event binding |
| `btn-clear-search` | "검색어 지우기" button inside no-results panel only (not persistent inline clear icon) | Recommend Codex also wire a persistent clear-X on the input itself |
| `sort-select` | `<select>` next to search input, same 4 logical values (`recent/name/size/extension`) | value binding; note: `api` legacy value dropped from the visible list — confirm with Codex whether still needed |
| `filter-chips` / `[data-filter]` | filter chip row, same 5 logical values (`all/pdf/image/document/other`) | delegated click → `activeFilter` binding, `aria-pressed` |
| `file-summary` | inline text in controls row | count/size/date text binding |
| `result-count` | same line, bold segment | filtered/total binding |
| `btn-download-all` | "전체 ZIP" button | all-ZIP action binding |
| `selected-count` | selection action bar count text | selection summary binding |
| `btn-selection-mode` | "선택" toggle button | selection-mode toggle binding |
| `drop-zone` | admin-files "파일 추가" panel (moved to admin-only) | drag/drop handlers, busy/dragging state |
| `upload-input` | hidden file input behind "파일 선택" button (admin) | picker binding |
| `upload-status` | admin-status step 3 ("ZIP 생성됨 · 미배포") | status-renderer binding |
| `btn-upload-pick` | "파일 선택" button (admin) | click → input.click() |
| `btn-select-all` | "전체 선택" in selection action bar | select-visible binding |
| `btn-clear-selection` | "선택 해제" in selection action bar | clear-selection binding |
| `btn-download-selected` | "선택 ZIP" in selection action bar | selected-ZIP binding |
| `file-list` | `<ul>` of file rows (all-files/recent-files/admin) | `createFileItem`-equivalent renderer; keyed by `f.id`, matches `.file-item[data-file-id]` contract conceptually |
| `preview-modal` / `preview-backdrop` | preview modal overlay | dialog open/close, Escape, focus trap, backdrop-click |
| `preview-meta` / `preview-title` | modal header (kicker text + filename) | metadata binding, `aria-labelledby` target |
| `btn-preview-close-top` | modal header × button | close binding |
| `preview-body` | modal body (viewer placeholder) | safe renderer + object-URL lifecycle |
| `btn-preview-download` | modal footer 다운로드 | download action binding |
| `btn-preview-print` | modal footer 인쇄 창 열기 | print capability binding (renamed per DOM_CONTRACT's suggested option) |
| `btn-preview-close` | modal footer 닫기 | close binding, initial-focus target on open |
| `qr-modal`, `qr-backdrop`, `qr-meta`, `qr-title`, `btn-qr-close-top`, `qr-canvas`, `qr-link`, `btn-qr-copy`, `btn-qr-close` | replaced by admin "공유 링크 만들기" modal (select file → link textarea → 복사) | **Behavior change, not just rename** — QR-canvas rendering dropped in this pass; Codex should confirm whether QR is still required for the capability-link flow or whether the copy-link modal fully replaces it |

## Structural/contract changes beyond IDs

- `.file-item[data-file-id]` pattern: keep — new file rows should carry `data-file-id` for selection/deep-link targeting even though visual structure changed.
- `.file-checkbox`: still a native checkbox, shown only in selection mode, same as before.
- `replaceChildren()` file renderer: **must be replaced.** The new design expects file-row buttons to keep their icon+label children (`<svg>` + text) permanently — Codex should swap `setButtonContent()`/`replaceChildren()` for a renderer that preserves child structure across re-renders (a keyed React-style renderer, not full-list `replaceChildren`).
- Filter/sort logical values preserved (`all/pdf/image/document/other`, `recent/name/size/extension`); `api` sort value not surfaced in the new sort control — confirm before dropping.
- `[hidden]` screen-switching replaced by a single `screen` enum in the new design; Codex's real implementation should map its state machine to drive one `screen`-like variable rather than multiple independent `hidden` flags, to avoid the two-source-of-truth risk called out in `DOM_CONTRACT.md`.

## New IDs/attributes introduced

- `data-prototype` on the disabled "새 링크 요청" button (expired-link) — marks a stubbed action per the implementation constraints.
- No other new persistent IDs were hard-coded; the prototype uses React state (`screen`, `selectionMode`, etc.) instead of DOM `hidden`/class toggles. Codex's DOM-adapter layer should assign stable IDs when wiring this structure to `app.js`, using the "old ID → new location" table above as the source mapping.
