# UI State Matrix

`구현`은 현재 코드에 독립 상태가 있음을, `부분`은 비슷한 화면은 있으나 원인·동작·표현이 부족함을, `없음`은 후속 구현이 필요함을 뜻한다.

| 상태 | 현재 | 화면의 진실한 기본 문구 | 필수 표시와 행동 | Design / Codex 경계 |
|---|---|---|---|---|
| 잠금 | 구현 | `전체 보관함 비밀번호를 입력하세요.` `공용 기기에서는 제한 공유 링크를 사용하세요.` | 전체 vault임을 표시, password label, 세션 유지 기본 off, 잠금 해제, 제한 링크 경로 분리 | Design: 두 진입의 위험 차이. Codex: capability routing과 unlock state. |
| 잘못된 비밀번호 | 부분 | 실제 crypto 인증 실패가 확인됐을 때만 `비밀번호가 맞지 않습니다. 다시 입력해 주세요.` | input에 오류 연결, `aria-invalid`, 재입력, network/format/integrity 오류와 분리 | Design: persistent inline error. Codex: typed error taxonomy. |
| 로딩 | 부분 | `복호화 키 만드는 중` → `암호화된 목록 받는 중` → `파일 목록 여는 중` | 현재 단계, busy/live status, 중복 제출 차단, 실제 취소 가능할 때만 취소 | Design: 단계별 component. Codex: 실제 단계 event와 auth-view busy state. |
| 파일 목록 | 구현 | `{표시 수} / {전체 수}개 파일` | 검색, sort, type filter, preview/인쇄, download, selection, refresh. 현재 filter/sort 명시 | Design: 인쇄 우선 hierarchy. Codex: runtime card renderer adapter. |
| 빈 파일 목록 | 구현 | `현재 배포된 파일이 없습니다.` | 새로고침. 일반 사용자에게 로컬 script 지시 금지. 관리자 진입은 별도 | Design: empty illustration/copy. Codex: user/admin error separation. |
| 검색 결과 없음 | 구현 | `“{검색어}”와 일치하는 파일이 없습니다.` | 검색 지우기, filter 초기화, 결과/전체 수 유지 | Design: no-result component. Codex: query/filter reset wiring. |
| 미리보기 | 부분 | 지원 형식에서만 `미리보기` `인쇄 창 열기` | filename/type/size, close, download, print capability, initial focus, focus trap, opener 복귀 | Design: viewer/action layout. Codex: safe renderer, focus manager, object URL lifecycle. |
| 미리보기 실패 | 부분 | renderer 실패: `이 브라우저에서 미리보기를 표시할 수 없습니다.` | network/fetch, decrypt/integrity, unsupported renderer를 구분. bytes가 검증됐을 때만 download 제안 | Design: 원인별 copy/action. Codex: error classification과 retry gating. |
| 다운로드 진행 | 부분 | `파일 받는 중` → `복호화 확인 중` → `브라우저에 다운로드를 요청했습니다.` | file name/size, 실제 진행량만 표시, 가능한 단계만 취소. 저장 완료라고 주장하지 않음 | Design: 단계와 cancelability. Codex: byte progress, AbortController, verified completion boundary. |
| 업로드 준비 | 부분 | `관리자용 암호화 업데이트 ZIP 준비 · 아직 업로드되지 않음` | 선택 파일, count/size, 동일 이름·Unicode 충돌, replace 여부, 제거, 취소, 계속 | Design: 관리자 전용 review step. Codex: validation, limits, collision policy. |
| 암호화 진행 | 부분 | `파일 암호화 중 {현재}/{전체} · {파일명}` | progress, cancel/rollback 가능 범위, 성공 시 `ZIP 생성됨 · 미배포`, 실패 시 기존 정상본 보존 | Design: progress/result. Codex: transactional encryption state. |
| 동기화 진행 | 없음, terminal만 | agent 연결과 실제 push 중일 때만 `암호화 결과 전송 중` | agent 미연결, staged, commit, push, retry, non-fast-forward를 구분. ZIP 생성과 분리 | Design: connection/sync states. Codex: authenticated localhost status API와 isolated Git operations. |
| 배포 대기 | 없음 | push 확인 뒤에만 `GitHub Pages 배포 확인 대기 중` | commit ID, 마지막 확인 시각, retry. served artifact 확인 전 `배포 완료` 금지 | Design: pending/success/error. Codex: Actions/Pages artifact verification. |
| 오류 | 부분 | `{확인된 원인}` `{영향}` `{기존 정상본 보존 여부}` `{다음 행동}` | retry, back, lock/exit, 관리자 상세 분리. 중요한 오류는 사라지는 toast만 사용하지 않음 | Design: persistent error pattern. Codex: error code와 recovery command. |
| 공용 기기 종료 | 없음 | `Print Drive가 관리하는 세션 데이터와 미리보기를 정리했습니다.` `방문·다운로드 기록, 내려받은 파일, 최근 파일, 프린터 기록은 지우지 못합니다.` | memory key, session/local app data, IndexedDB, Cache Storage, SW, object URL, preview DOM, fragment 정리 결과. 탭 닫기와 수동 checklist | Design: 강조된 종료와 한계 확인. Codex: best-effort cleanup과 결과 report. |
| 만료된 공유 링크 | 없음 | `이 링크는 열 수 없습니다. 만료되었거나 공유 파일이 더 이상 제공되지 않습니다.` | 새 링크 요청, 안전한 진입으로 이동. 정적 hosting에서 시간/횟수 만료를 보장한다고 쓰지 않음 | Design: invalid/expired/revoked 공통 복구. Codex: capability validation, backend 유무에 따른 semantics. |

## 공통 상태 규칙

1. **완료 경계**: ZIP 생성, browser download 요청, Git push, Pages artifact 반영, 실제 인쇄를 서로 다른 사건으로 표시한다.
2. **취소 경계**: 현재 operation을 실제로 중단할 수 있을 때만 `취소`를 활성화한다.
3. **오류 보존성**: local encryption/sync 실패에는 기존 정상 배포본이 유지됐는지 표시한다.
4. **공용 기기 한계**: 앱이 제어할 수 없는 browser/OS/printer 기록 삭제를 암시하지 않는다.
5. **접근성**: 진행은 `role=status`, 실패는 적절한 alert/description, dialog는 focus trap과 opener 복귀를 갖는다.
6. **관리자 분리**: public file browsing 화면에 local script, Git, secret, deployment 지시를 직접 노출하지 않는다.
