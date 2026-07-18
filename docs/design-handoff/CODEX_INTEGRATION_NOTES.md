> [!IMPORTANT]
> **Imported design reference — not production behavior.** 이 문서는 `.tmp/claude-design-import-20260718`의 Claude 프로토타입 산출물을 2026-07-18에 기계적으로 가져온 참고 자료다. `Print Drive.dc.html`, `support.js`, React/DC runtime, prototype toolbar는 배포하지 않는다.
>
> 현재 통합은 vanilla `index.html` / `styles.css` / ES module 구조를 사용하며 기존 51개 DOM ID와 `.file-item[data-file-id]`, `.file-checkbox`, `[data-filter]` 계약을 유지한다. 원문에 적힌 “기존 ID 전부 제거”, “모든 target 44px 완료”, “modal 접근성 동작 완료” 같은 표현은 **가져온 프로토타입 자체에 대한 설명 또는 목표**이지 현재 runtime 기능 완료를 뜻하지 않는다. Capability 공유, public-device cleanup, typed error, modal focus trap, sync/deploy는 실제 코드와 test가 연결된 뒤에만 완료로 간주한다.

---

# Codex Integration Notes — Print Drive redesign

Read `DOM_CHANGES.md` first (ID-level mapping). This file covers behavioral wiring, not layout.

## 1. State machine to build

The prototype drives everything off one `screen` value (see `Print Drive.dc.html`'s `state.screen`) plus a few local toggles (`selectionMode`, `previewCause`, `lockDemo`, etc. — the last few are demo-only, listed in §4). Recommended real state machine:

```
mode: 'public' | 'vault' | 'admin'
authState: 'locked' | 'deriving-key' | 'fetching-manifest' | 'unlocked' | 'invalid-password' | 'network-error'
listState: 'ready' | 'empty' | 'no-results' | 'error'
fileOpState: per-file 'idle' | 'fetching' | 'verifying' | 'ready' | 'error:{network|integrity|unsupported}'
zipState: 'idle' | 'running' | 'cancelling' | 'done' | 'error'
syncState: 'idle' | 'agent-disconnected' | 'staging' | 'pushing' | 'pending-deploy' | 'error' | 'verified-deployed'
```

Map the design's `screenIs.*` booleans and `lockDemo`/`previewCause` toggles onto these real states — they were built as manually-switchable demo values specifically so each combination could be reviewed, not as the real state shape.

## 2. Critical: `setButtonContent()` / `replaceChildren()`

`DOM_CONTRACT.md` flags that the current renderer calls `replaceChildren()` on buttons, which will delete the icon+label markup this design specifies (every action button pairs an SVG icon with visible text, e.g. 미리보기·인쇄). Before wiring file rows, replace that helper with one that either (a) diffs/patches children instead of clearing them, or (b) accepts a pre-built node/template per button type. This blocks nearly every file-row and header-action button in the new design.

## 3. Mode/capability routing (P0)

The redesign's mode-select → limited-link / vault-lock / admin-confirm branching is pure UI in this pass. Real routing depends on Codex's capability work:
- `#file=<id>` deep links today still require full vault unlock. Until scoped capability keys ship, keep the limited-link screen's honest copy ("전체 보관함 잠금 해제가 필요합니다") — do not swap in password-less copy before the backend supports it.
- Admin-mode entry currently only shows a confirm dialog (no second auth). Decide whether admin mode should gate on anything beyond the vault password (e.g. a localhost agent pairing check) before exposing 파일 추가/교체/삭제 in production.

## 4. Demo-only affordances to strip before ship

These toolbar/toggle controls exist purely so every state could be screenshotted and reviewed; they are visually marked `PROTOTYPE` and must not ship:
- Top prototype nav bar (screen picker, theme toggle, device-width toggle).
- `lockDemo` buttons (기본/로딩/오류-비번/오류-망) — replace with real auth-state transitions.
- `linkStep` gate/file toggle — replace with real "link resolved" transition.
- `previewCause` network/integrity/unsupported toggle — replace with real error classification from the fetch/decrypt/render pipeline.
- Manual light/dark toggle — real app stays `prefers-color-scheme`-only per current constraints (design still supports both; toggle was for review convenience only).

## 5. Accessibility work still open (design specifies shape; behavior is Codex's)

- Modal focus trap, background `inert`, Escape-to-close, and opener-focus-restore for preview/admin-confirm/share-link/delete-confirm modals — the DOM shape (header/body/footer, close buttons) is final; behavior is not implemented in the static prototype.
- `aria-live="polite"` region for the vault-lock staged loading text (currently just rendered text).
- `aria-pressed` wiring on filter chips or a role=`group` treatment.
- Full keyboard-order QA pass once real modal/dialog semantics are attached.

## 6. Known gaps flagged for a follow-up design pass (not required for this milestone)

- No persistent ZIP in-flight progress/cancel UI beyond the `선택 ZIP`/`전체 ZIP` trigger buttons — `btn-cancel-zip`'s equivalent has not been designed yet.
- No global operation overlay (`global-loader` equivalent) spanning refresh/ZIP/upload — only vault-lock's loading overlay exists today.
- `btn-install` (PWA) and `btn-refresh` have no home in the new header; recommend a "더보기" overflow menu (a stub button exists in the files-shell header, unwired).
- QR-code rendering (`qr-canvas`) was replaced conceptually by a text/link "공유 링크 만들기" modal — confirm with product whether QR is still required once true scoped-capability links exist, since a QR is arguably more useful for a public-device flow than a copyable link.

## 7. Truthfulness guardrails to preserve verbatim

Do not let future copy edits reintroduce the phrases this brief explicitly forbids (see `DESIGN_BRIEF.md` §"보안상 금지할 허위 표현"). The current implementation of these strings in `Print Drive.dc.html` is the source of truth for wording; keep the 원인/영향/보존/다음행동 shape on every persistent error panel when you wire real error data in.
