# Threat model

## 자산과 경계

보호 대상은 평문 파일, passphrase, VMK, per-file DEK, 복호화된 browser bytes입니다. 신뢰 경계는 원본을 보유한 로컬 기기, 사용자가 명시적으로 연 제한 공유 세션, 그리고 검토된 앱 JavaScript를 전달하는 Pages origin입니다. 암호문을 보관하는 Git history/CDN은 기밀성 측면에서 신뢰하지 않지만, 실행 코드 전달의 무결성은 TLS·GitHub 계정·workflow·branch 보호에 의존합니다. 공용 기기 저장장치와 printer는 신뢰하지 않습니다.

## 공격자 모델

- 공개 저장소와 과거 commit을 모두 내려받는 offline 공격자
- 암호문이나 manifest를 변조하는 저장소·네트워크 공격자, 또는 앱/service-worker 자체를 바꾸는 배포 계정 공격자
- capability 링크를 전달받거나 clipboard/history에서 획득한 사람
- 악성 파일명·ZIP 경로·HTML/SVG payload를 넣으려는 source 작성자
- 공용 기기의 다음 사용자, browser extension, OS recent-file·printer 기록 관찰자
- 잘못된 branch/remote, push 실패, 중간 종료 같은 비악의적 운영 장애

## 적용된 통제

- AES-256-GCM 인증, context-specific canonical AAD, ciphertext/plaintext SHA-256 검증
- strict schema, canonical base64url/NFC, ID/path/size/count/KDF bounds, duplicate nonce·identity 차단
- 파일별 random DEK와 immutable blob, 변경 object만 교체, transactional manifest commit
- v2 `objectIndex`와 실제 blob의 path/size/hash 대조, orphan/stale artifact 차단
- 파일명을 text node로 렌더링하고 bidi control·selector injection·ZIP traversal을 거부
- HTML/SVG/XML inline preview 금지, 제한된 MIME allowlist, sandbox iframe, same-origin/no-referrer fetch
- capability fragment를 body/module graph보다 먼저 읽고 주소창에서 제거; public mode에서 trusted operation 취소와 SW 정리
- lock/route/pagehide epoch와 AbortController로 늦게 끝난 복호화가 다른 화면에 plaintext를 다시 표시하지 못하게 함
- output-only Git stage/commit, branch/remote/upstream guard, non-fast-forward 자동 해결 금지

## 잔여 위험

공개 암호문은 약한 passphrase에 대한 offline guessing을 허용합니다. ciphertext padding은 정확한 크기를 흐리지만 개수·대략적 크기·변경 시각을 숨기지 않습니다. bearer capability를 가진 누구나 표시 만료 전 해당 파일을 열 수 있고, backend가 없어 회수·횟수·서버 만료를 강제하지 못합니다.

공용 종료는 앱 소유 memory/storage/cache/SW/object URL만 best effort로 정리합니다. 다운로드 파일, clipboard, screenshot, browser/OS history, printer queue는 남을 수 있습니다. 이미 열린 OS 인쇄 dialog도 회수할 수 없습니다. 기기나 extension이 이미 침해됐다면 입력·복호화 순간의 key/plaintext 보호를 보장하지 않습니다.

`robots.txt`, private browsing, URL fragment는 접근 통제가 아닙니다. 강한 framing·MIME·Permissions-Policy header가 필요하면 GitHub Pages가 아닌 별도 origin을 사용해야 합니다.

Pages origin이나 저장소 배포 권한이 침해되어 악성 앱/service-worker가 전달되면 same-origin JavaScript는 입력한 passphrase와 복호화 bytes를 유출할 수 있습니다. AES-GCM, CSP와 service-worker 정리는 신뢰할 수 없는 앱 코드 자체를 방어하지 못합니다. branch protection, 최소 workflow 권한, 계정 MFA, 배포 이력 검토가 이 경계의 운영 통제입니다.
