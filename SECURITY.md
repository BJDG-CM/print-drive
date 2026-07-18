# Security policy

## 보호 범위

Print Drive는 평문 원본과 passphrase를 신뢰 기기에 두고 공개 저장소에는 암호화된 manifest와 immutable object만 배포합니다. 공개 저장소·GitHub Pages·CDN·네트워크 관찰자는 암호문을 읽을 수 있다고 가정합니다. 파일 개수, padded 크기, 변경·배포 시각, 저장소 이력과 접속 흔적은 비밀이 아닙니다.

v2는 PBKDF2-SHA-256으로 만든 KEK가 random vault master key(VMK)를 감싸고, VMK에서 HKDF-SHA-256으로 manifest key와 DEK-wrap key를 분리합니다. 각 파일은 독립 random DEK와 AES-256-GCM nonce를 사용합니다. 자세한 계약은 `docs/CRYPTO_FORMAT.md`에 있습니다.

## 확인된 과거 이력 노출

2026-07-18 감사에서 현재 tracked tree가 아니라 과거 Git 이력에 평문 확장자를 가진 `files/` 경로 11개와 복구 가능한 blob이 존재함을 확인했습니다. 따라서 해당 과거 파일은 공개된 것으로 취급해야 합니다. 이 변경은 force push나 history rewrite를 자동 실행하지 않습니다. `scripts/check_history_paths.mjs`는 확인된 경로 집합을 이름 대신 SHA-256 기준선으로 고정해 그 path 집합의 추가·제거 같은 승인되지 않은 변경을 실패시키지만, 같은 경로의 새 content나 다른 이름의 plaintext 부재까지 증명하지 않으며 이미 복제·cache된 사본을 회수할 수도 없습니다. 민감도 평가, 관련 credential/passphrase 교체, 승인된 `git filter-repo` 또는 새 저장소 이전 절차는 `docs/RECOVERY.md`를 따릅니다.

## 운영자가 지켜야 할 사항

- 평문 source, `.print-drive-passphrase`, 실제 `print-drive.config.json`, token과 `.env`를 commit하지 않습니다.
- 긴 고유 passphrase와 별도 offline backup을 사용합니다. 암호문은 공개되므로 약한 passphrase는 offline 추측에 취약합니다.
- 신규·migration 완료 배포는 `npm run verify`와 v2 public guard를 통과해야 합니다. 현재 tracked `files/`는 아직 v1 compatibility snapshot이므로 명시적 migration 전에는 v2의 stale/reference 검증 보장을 적용할 수 없습니다.
- 공용 기기에는 vault passphrase를 입력하지 않고 v2 파일별 capability를 사용합니다.
- capability URL 자체가 bearer 권한입니다. 신뢰 채널로만 전달하며 정적 호스팅에서는 서버 강제 만료·회수·횟수 제한이 없다고 가정합니다.
- 의심되는 노출이 있으면 먼저 credential/passphrase를 교체하고 `docs/RECOVERY.md` 절차로 범위를 조사합니다. 도구가 Git 이력을 자동 재작성하지는 않습니다.

일상적인 비밀번호 변경은 blob을 재암호화하지 않기 위해 같은 VMK를 새 password slot으로 다시 감쌉니다. 과거 passphrase가 실제로 노출된 경우에는 이것만으로 접근을 취소할 수 없습니다. Git history의 과거 slot으로 같은 VMK를 얻은 공격자는 이후 v2 manifest/blob도 열 수 있으므로, 새 VMK로 전체 vault를 재생성하고 기존 history를 격리하거나 승인된 rewrite/새 저장소 이전을 수행해야 합니다. 이미 공개된 과거 plaintext나 암호문은 회수할 수 없습니다.

## 보고

취약점을 공개 issue에 평문 secret이나 실제 암호문과 함께 올리지 마세요. 저장소 소유자에게 재현 조건, 영향 범위, 사용한 version/commit, 가능한 최소 fixture를 비공개 채널로 전달하세요. 운영자가 private reporting 채널을 아직 설정하지 않았다면 GitHub의 private vulnerability reporting을 먼저 활성화해야 합니다.

## 보장하지 않는 것

이 프로젝트는 계정 인증, rate limit, 서버 측 접근 취소, printer/spooler 정리, browser 전체 방문·download history 삭제, 악성·감염된 기기에서의 키 보호를 제공하지 않습니다. GitHub Pages에서 설정할 수 없는 보안 response header는 header 제어가 가능한 별도 hosting이 필요합니다.
