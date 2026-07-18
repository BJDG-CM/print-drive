# Design implementation

Claude Design의 prototype과 handoff 문서를 시각·정보 구조 참고로 사용하고, 실제 vanilla runtime의 DOM hook과 보안 상태 machine에 연결했습니다. `docs/design-handoff/`의 component/decision/DOM mapping은 원본 설계 기록이며 완료 증거가 아닙니다.

## 통합한 항목

- 일반 주소의 직접 잠금 해제, 선택 파일 공유의 직접 진입, 이전 링크 경고, 공용 기기 종료 결과를 분리한 구조
- 기존 51개 DOM hook 보존과 추가 public/admin hook, runtime file row 연결
- 실제 최근 10개/전체 탭, 전체 대상 검색·filter·sort, 선택 ZIP·preview·인쇄의 실제 state와 copy
- normal file browser 밖의 별도 관리 화면과 로컬 apply 명령을 안내하는 암호화 update package 흐름
- desktop/tablet/mobile 반응형 layout, touch target, visible focus, dark mode
- dialog focus trap, background inert, opener 복귀, live status/error, heading focus와 keyboard 흐름
- public mode에서 만료·idle·cleanup 결과 및 앱이 지울 수 없는 흔적을 과장 없이 표시
- update package는 `다운로드 요청됨·아직 적용되지 않음`으로 표시해 적용 완료처럼 보이지 않게 함

## 의도적으로 사용하지 않은 prototype runtime

prototype의 CDN React/ReactDOM, `new Function`, wildcard `postMessage`, 가짜 progress와 fixture-only action은 production에 포함하지 않았습니다. production은 local external CSS/JS만 허용하는 CSP와 build dependency graph를 사용합니다. `support.js`와 prototype HTML은 dist/SW에 들어가지 않습니다.

보안상 capability fragment를 dependency graph보다 먼저 제거해야 하므로 기존 bottom의 direct module script 대신 head의 작은 외부 `bootstrap.js`가 dynamic import entry가 됩니다. build/DOM/SW contract test가 이 adapter를 고정합니다.

## 실제 상태 경계

- browser 관리 화면은 encrypted package download까지만 수행하며 저장소 write나 배포를 하지 않습니다.
- trusted unlock 이후에만 service worker를 등록합니다.
- v1 `#file=`은 제한 공유가 아니라 전체 password가 필요한 위치 링크로 명시합니다.
- v2 QR은 길이에 따라 encoder capacity를 넘을 수 있어 copy-link fallback을 제공합니다.
- 미리보기는 PDF, 제한된 raster image와 작은 text allowlist만 지원합니다. HTML/SVG/XML은 active preview하지 않습니다.

시각 변경 검증은 synthetic v2 fixture만 사용해야 하며 실제 `files/`나 passphrase를 디자인 fixture로 바꾸지 않습니다.
