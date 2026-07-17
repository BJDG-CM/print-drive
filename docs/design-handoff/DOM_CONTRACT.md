# DOM Contract

`index.html`의 정적 ID 51개는 모두 `app.js:61-112`에서 시작 시 즉시 조회된다. null guard가 없으므로 Claude 산출물에서 하나라도 빠지면 초기화 또는 관련 흐름이 깨진다.

권고 표기:

- **Native**: ID와 native element/type을 유지한다.
- **Hook**: ID와 `hidden`, `textContent`, `disabled`, `focus` 등 사용 API를 유지하면 위치와 시각 구조는 자유롭다.
- **Coupled**: ID 외에 자식 selector, class, data attribute, ARIA 또는 renderer 계약도 유지한다.
- ID를 바꾸는 디자인은 가능하지만 Codex 통합 때 아래 adapter를 먼저 적용해야 한다.

## Shell, 잠금, 로딩

| 현재 DOM ID | 연결된 JavaScript 기능 | 유지 필요 여부 | 변경 가능한 범위 | 변경 시 필요한 adapter |
|---|---|---|---|---|
| `toast-root` | toast append/remove, `app.js:1473-1481` | Hook, `aria-live` 유지 | 위치·스타일 | toast portal target과 live-region mapping |
| `auth-view` | 잠금 화면 전환, `142-155, 219-230, 335-348, 1433-1436` | Hook | 내부 layout | view state mapping과 `hidden` adapter |
| `password-form` | submit → unlock, `159, 233-267` | Native `form` | 내부 layout | click handler와 Enter-submit semantics |
| `password-input` | value, clear, focus, select, `235, 257, 344, 1373-1375, 1442` | Native password input | wrapper·label style | value/focus adapter와 autocomplete 정책 |
| `auth-submit` | unsupported/derive 중 disabled, `144, 241, 264` | Native button | label·style | submit/disabled mapping |
| `remember-session` | checked 값으로 sessionStorage 결정, `251-255` | Native checkbox | toggle 표현 | checked-state adapter |
| `auth-error` | error text와 hidden, `1439-1447` | Hook | persistent panel 가능 | error renderer, `aria-describedby`, alert/live mapping |
| `loading-view` | 초기/stored-key loading view, `220, 1415-1416` | Hook | skeleton 등으로 교체 가능 | loading view state mapping |
| `app-view` | unlocked root, view visibility, `selection-mode` class | Coupled | 내부 IA 변경 가능 | view root 및 selection-state class adapter |
| `global-loader` | app 작업 overlay hidden, `1424-1430` | Hook | dialog/progress panel 가능 | operation overlay controller |
| `loading-message` | refresh/ZIP/upload progress text | Hook | progress UI 구조 | operation별 status adapter |
| `btn-cancel-zip` | ZIP cancel click, hidden, disabled | Native button | 위치·label | cancel action과 availability mapping |

## Header, 검색, 요약

| 현재 DOM ID | 연결된 JavaScript 기능 | 유지 필요 여부 | 변경 가능한 범위 | 변경 시 필요한 adapter |
|---|---|---|---|---|
| `btn-install` | PWA install prompt, `198-202, 1535-1543` | Native | 신뢰 기기 menu로 이동 가능 | install capability/state mapping, CSS special-case 제거 |
| `btn-page-qr` | 현재 page QR open | Native | menu로 이동 가능 | open-QR action mapping |
| `btn-refresh` | manifest refresh, loading disabled | Native | 위치·label | refresh action/state mapping |
| `btn-lock` | vault lock, loading disabled | Native | 공용 `사용 종료`와 분리 가능 | lock action과 public-exit action을 별도 mapping |
| `search-input` | input → filter, query/highlight, reset | Native search input | wrapper·보이는 label | query state, input event, focus mapping |
| `btn-clear-search` | query clear, hidden/disabled | Native button | input affordance 변경 | clear action과 visibility mapping |
| `sort-select` | change → sort | Native select 또는 완전 adapter | 시각 control 교체 가능 | 값 `recent/name/size/extension/api` ↔ 새 control mapping |
| `filter-chips` | delegated click, active, `aria-pressed`, disabled | Coupled | chip layout/style | 자식 `data-filter=all/pdf/image/document/other` 또는 filter adapter |
| `file-summary` | 전체 count/size/latest update text | Hook | 위치·분리 표시 | summary fields renderer |
| `result-count` | filtered/all count text | Hook | 위치·문구 | result-count renderer |
| `btn-download-all` | all files ZIP | Native | overflow menu 가능 | all-ZIP action/state mapping |
| `selected-count` | selected count/size와 hidden | Hook | action bar로 이동 가능 | selection summary renderer |
| `btn-selection-mode` | selection mode toggle, active, dynamic label | Native | file-list toolbar로 이동 가능 | selection mode command/state mapping |

## 관리자 update ZIP, 선택, 목록

| 현재 DOM ID | 연결된 JavaScript 기능 | 유지 필요 여부 | 변경 가능한 범위 | 변경 시 필요한 adapter |
|---|---|---|---|---|
| `drop-zone` | dragenter/over/leave/drop, `dragging/busy`, `contains` | Coupled | 관리자 panel로 이동 가능 | drag target, busy state, drop validation adapter |
| `upload-input` | hidden `type=file multiple`, `.files`, reset value | Native file input | 시각적으로 숨긴 위치 | picker adapter와 multi-file contract |
| `upload-status` | ZIP 생성 success/failure/reset | Hook | 단계형 status 가능 | update-package status renderer |
| `btn-upload-pick` | `upload-input.click()`, disabled | Native button | 관리자 단계 안에서 이동 | picker action/state mapping |
| `btn-select-all` | visible results 전체 선택/해제 | Native | selection toolbar 위치 | select-visible command mapping |
| `btn-clear-selection` | selected set clear | Native | 위치·label | clear-selection command mapping |
| `btn-download-selected` | selected ZIP, dynamic label, disabled | Native | sticky action 가능 | selected-ZIP command/state mapping |
| `file-list` | 동적 file/state mount, list focus, child query | Coupled | card 시각 구조 전면 변경 가능 | `createFileItem`, state renderer, focus target를 함께 교체 |

## Preview dialog

| 현재 DOM ID | 연결된 JavaScript 기능 | 유지 필요 여부 | 변경 가능한 범위 | 변경 시 필요한 adapter |
|---|---|---|---|---|
| `preview-modal` | dialog open/close, Escape, hidden | Hook, dialog semantics | modal library 사용 가능 | modal controller, inert, focus trap, opener restore |
| `preview-backdrop` | click-to-close | Hook | 제거 가능 | modal library backdrop/close policy |
| `preview-meta` | type/size/date text | Hook | header/footer 이동 | preview metadata renderer |
| `preview-title` | filename과 `aria-labelledby` target | Hook | heading level/style | dialog label mapping |
| `btn-preview-close-top` | header close | Native | 한 개 close로 통합 가능 | close command와 focus target mapping |
| `preview-body` | iframe/image/pre/fallback replace/append | Coupled | viewer layout 변경 가능 | safe viewer renderer와 object URL lifecycle |
| `btn-preview-download` | preview file download, failure initial focus | Native | action bar 이동 | download action/state mapping |
| `btn-preview-print` | print, failure disabled | Native | `인쇄 창 열기`로 rename 가능 | print capability/state mapping |
| `btn-preview-close` | footer close, success initial focus | Native | 상단 close와 통합 가능 | initial focus와 close command mapping |

## QR dialog

| 현재 DOM ID | 연결된 JavaScript 기능 | 유지 필요 여부 | 변경 가능한 범위 | 변경 시 필요한 adapter |
|---|---|---|---|---|
| `qr-modal` | dialog open/close, Escape, hidden | Hook, dialog semantics | share sheet/dialog 변경 가능 | modal controller와 opener focus restore |
| `qr-backdrop` | click-to-close | Hook | 제거 가능 | modal library backdrop policy |
| `qr-meta` | QR context text | Hook | 위치·문구 | share metadata renderer |
| `qr-title` | dialog title와 `aria-labelledby` target | Hook | heading style | dialog label mapping |
| `btn-qr-close-top` | header close | Native | 한 개 close로 통합 가능 | close command mapping |
| `qr-canvas` | `qr.js` canvas 2D renderer target | Native `canvas` | 크기·위치 | SVG/img로 바꾸면 QR renderer 전체 adapter 필요 |
| `qr-link` | URL/fallback text | Hook | copy field로 교체 가능 | link renderer와 fallback mapping |
| `btn-qr-copy` | clipboard action, initial focus | Native | share action bar 이동 | clipboard action/result mapping |
| `btn-qr-close` | footer close | Native | 상단 close와 통합 가능 | close command mapping |

## ID 밖의 필수 계약

| 계약 | 현재 사용처 | 디자인 변경 허용 범위 | 통합 시 주의 |
|---|---|---|---|
| `[hidden]` | 세 view, overlay, modal, controls | animation state로 교체 가능 | JS state와 표시 state가 갈라지지 않게 단일 controller 필요 |
| `.file-item[data-file-id]` | selection, deep link, selected style | card nesting 전면 변경 가능 | stable file key와 query target 보존 |
| `.file-checkbox` | selection checked/hidden | custom checkbox 가능 | native checked, label, keyboard semantics adapter 필요 |
| `#app-view.selection-mode` | action bar, checkbox, selected styling | 다른 state model 가능 | renderer와 CSS를 동시에 바꿔야 함 |
| `[data-filter]` | delegated filter click | chip/button/menu 가능 | exact logical values를 유지하거나 mapping 필요 |
| `.btn-label` | `setButtonContent()`와 responsive label hiding | Claude button children 사용 가능 | 현재 `replaceChildren()`가 Claude markup을 삭제하므로 helper 수정 필요 |
| `replaceChildren()` file renderer | filter/sort마다 목록 전체 재생성 | keyed rendering 가능 | selection, focus, details open state를 보존하는 renderer 필요 |
| preview object URL | modal open/close, print | viewer library 가능 | close, lock, error, route change마다 revoke 보장 |
| sort values | `recent/name/size/extension/api` | copy와 control 변경 가능 | logical value mapping 유지 |
| filter values | `all/pdf/image/document/other` | archive chip 추가 가능 | 기존 `other`가 archive까지 포함하는 동작을 명시적으로 변경 |

## Claude 산출물 통합 규칙

1. 새 HTML에 기존 ID를 임시로 유지하는 것이 가장 안전하다.
2. ID를 제거하거나 element type을 바꿀 경우 `DOM_CONTRACT.md`의 adapter 항목을 산출물에 표시한다.
3. 파일 카드와 상태 item은 정적 mock뿐 아니라 runtime component spec도 제공한다.
4. button 내부 icon/label 구조는 현재 `ui.setButtonContent()`가 덮어쓰므로 원하는 구조를 명시하고 Codex가 helper를 교체하게 한다.
5. modal, selection, filter, sort는 보이는 시안만으로 완료로 간주하지 않는다. state와 keyboard behavior를 함께 정의한다.
