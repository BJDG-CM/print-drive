> [!IMPORTANT]
> **Imported design reference — not production behavior.** 이 문서는 `.tmp/claude-design-import-20260718`의 Claude 프로토타입 산출물을 2026-07-18에 기계적으로 가져온 참고 자료다. `Print Drive.dc.html`, `support.js`, React/DC runtime, prototype toolbar는 배포하지 않는다.
>
> 현재 통합은 vanilla `index.html` / `styles.css` / ES module 구조를 사용하며 기존 51개 DOM ID와 `.file-item[data-file-id]`, `.file-checkbox`, `[data-filter]` 계약을 유지한다. 원문에 적힌 “기존 ID 전부 제거”, “모든 target 44px 완료”, “modal 접근성 동작 완료” 같은 표현은 **가져온 프로토타입 자체에 대한 설명 또는 목표**이지 현재 runtime 기능 완료를 뜻하지 않는다. Capability 공유, public-device cleanup, typed error, modal focus trap, sync/deploy는 실제 코드와 test가 연결된 뒤에만 완료로 간주한다.

---

# Design Decisions — Print Drive

Companion to `DESIGN_BRIEF.md` / `CURRENT_UI.md` / `STATE_MATRIX.md` / `DOM_CONTRACT.md`. This covers what changed in the redesign (`Print Drive.dc.html`) and why. It is a design/frontend prototype — crypto, key hierarchy, sync, and deploy logic are unchanged from the current repo and are not reimplemented here.

## 1. Entry point split (P0)

The single "전체 보관함 비밀번호" gate is replaced with a **mode-select** screen offering two distinct paths:
- **공유 링크로 파일 열기** — public-device path, scoped framing, print-first.
- **전체 보관함 열기** — trusted-device vault path, full browse/search/manage.

This directly answers the brief's #1 UX problem: public-device users should never be steered toward the master password by default. The limited-link screen still requires the vault password today (this is honestly disclosed — see §6), but its UI never exposes browse/search/admin surface, so the *risk surface* is already separated even before Codex ships scoped capability keys.

## 2. Context separation via three shells

Three visually distinct shells, not just three routes:
- **Public** (limited-link, public-exit): minimal chrome, no header nav, printer-first CTA, persistent "공용 기기 사용 종료".
- **Vault** (recent/all files, preview): standard light header, tabs for 최근/전체, search+filter+sort, selection.
- **Admin**: dark slate top bar + amber "관리자 모드" badge + explicit "← 사용자 화면으로" exit, entered only through a confirm dialog explaining the risk ("파일 추가·교체·삭제와 배포 상태를 다룹니다"). This satisfies "명확한 별도 진입점" without a second real auth factor (that's Codex's capability-routing work).

## 3. Print-first hierarchy

Every file row's primary action is **미리보기·인쇄** (primary button, printer icon) — download is always secondary. The limited-link post-unlock screen leads with a full-width 인쇄 창 열기 button; download sits below it. This flips the current implementation's "preview is primary, print is a modal action" ordering per the brief's design principle #1.

## 4. Truthful state language

Copy was rewritten against the brief's forbidden/approved phrase lists:
- Update ZIP flow reads "업데이트 ZIP 생성됨 · 아직 업로드되거나 배포되지 않았습니다" at every step, never "업로드됨"/"배포됨"/"동기화됨".
- Public-exit shows two explicit lists — items Print Drive actually cleared vs. items it cannot touch (browser download/print/visit history, OS recent files) — instead of one blanket "흔적을 지웠습니다" message.
- Print action copy is "인쇄 창을 열었습니다" (a toast), never "인쇄 완료".
- The limited-link gate is labeled "파일 위치 링크 · 전체 보관함 잠금 해제가 필요합니다", matching the brief's recommended current phrasing — the ideal password-less scoped link is explicitly called out as **준비 중** in a caption, not implied as shipped.
- Sync error panel always states what's preserved: "기존에 배포된 파일은 그대로 유지됩니다."

## 5. Error taxonomy over generic toasts

Lock, preview, and sync errors are each modeled as **persistent, distinct states** rather than one shared toast:
- Vault lock: idle / loading (staged status text) / wrong-password (inline `aria-invalid` field error) / network (different copy, same field left untouched) — demonstrated via a toolbar toggle since real staging requires Codex's typed error events.
- Preview failure: network (retry, no download — bytes unverified), integrity (retry, no download — corrupt), unsupported format (no retry, download enabled — bytes are fine, renderer just can't show them). Action availability changes per cause, matching STATE_MATRIX's rule that download is only offered when bytes are verified.
- Sync failure: persistent panel with 원인 / 영향 / 보존 여부 / 다음 행동, not a 3.2s toast.

## 6. What is intentionally still a stub

Per `CODEX_TODO_AFTER_DESIGN.md`, these are shown as UI only, clearly non-functional:
- Limited-link still gates on the full vault password (honest label, no fake scoped-key UX).
- "공유 링크 만들기" (admin) generates a static example link and states plainly it needs the vault password and cannot enforce expiry/use-count.
- "새 링크 요청" on the expired-link screen is `disabled` + `data-prototype`.
- Admin sync/deploy steps show illustrative status only; no live agent/Git/Pages calls exist.

## 7. Visual system

- Palette kept in the existing blue family (brand continuity) but the dark-mode primary was changed from `#60a5fa` (flagged ~2.5:1 contrast under white text) to a darker `#2f6fed` fill for buttons, with a lighter `#8fb4fb` reserved for text-only accents on dark surfaces — fixes the P1 contrast defect called out in `CURRENT_UI.md`.
- File rows changed from boxed/shadowed cards to a flat divided list (border-bottom only) — closer to a file-explorer feel, avoids "wrap everything in a card."
- Admin shell uses a dark top bar + amber badge as the sole "danger/权限" cue, rather than heavier chrome throughout.
- All status (완료/진행 중/미배포/대기/실패) is a text label + colored chip, never color alone.
- Icons are minimal line-SVGs (search, lock, printer, download, close) or plain characters (✓, i, !) — no illustrative/decorative art.

## 8. Responsive & device parity

Layout is fluid (flex-wrap, `min-width:0`, 2-line clamp on filenames) so it reflows continuously from 360–1440px without separate breakpoint markup. The prototype toolbar's "모바일 390" toggle constrains the stage to a 390px frame for direct side-by-side review; it is a review aid, not shipped product chrome. All interactive targets are ≥44×44px.

## 9. Dark mode

Design covers both themes at every screen via a manual toggle in the prototype toolbar (marked `PROTOTYPE`, not part of the shipped app — the real app still follows `prefers-color-scheme` only, as noted in the brief's technical constraints).
