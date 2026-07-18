# Print Drive 복구 절차

복구 전 auto sync를 종료하고 저장소와 encrypted output을 별도 위치에 backup한다. 아래 절차는 force push나 history rewrite를 자동 실행하지 않는다.

## 평문 source 연결을 잃은 경우

새 source라고 가정해 바로 mirror하지 않는다. encrypted output과 passphrase backup을 보존한 뒤 다음 dry-run으로 exact/changed/local-only/remote-only/moved를 확인한다.

```powershell
npm run source:relink -- --source "D:/Recovered-PrintDrive-Inbox" --expected-vault-id <vault-id>
```

모두 exact면 `--adopt`로 config/state만 복구한다. remote-only가 있으면 기본 `--add-replace`가 보존한다. `--mirror`는 검토·backup·명시적 확인 뒤에만 사용한다. content가 다른 파일을 exact로 표시하거나 다른 vault ID를 우회하지 않는다.

## push 실패 후 local commit이 남은 경우

```powershell
node scripts/config_cli.mjs dry-run
git status --short --branch
git log --oneline "@{upstream}..HEAD"
git fetch origin main
git rev-list --left-right --count "HEAD...@{upstream}"
```

remote가 앞서지 않고 local만 앞서면 다음을 실행한다.

```powershell
git push origin HEAD:refs/heads/main
```

성공 후 `python auto_sync.py`를 다시 시작한다. output 변경이 새로 없어도 동기화기는 pending ahead commit을 확인한다.

## non-fast-forward

동기화기는 merge, rebase, force push를 실행하지 않는다.

1. `git status`에서 자동 sync 외의 staged/unstaged 변경을 확인한다.
2. 사용자 변경을 별도 commit하거나 안전한 patch/backup으로 보존한다.
3. `git fetch origin main` 후 양쪽 commit을 검토한다.
4. 적합한 경우에만 사용자가 직접 `git pull --rebase origin main`을 실행한다.
5. conflict를 해결하고 전체 테스트를 실행한다.
6. `node scripts/config_cli.mjs check`와 `dry-run` 후 sync를 재시작한다.

공유 branch에 `--force` 또는 `--force-with-lease`를 사용해 자동 sync를 복구하지 않는다.

clean 상태에서 remote만 앞섰다면 현재 동기화기는 encryption 전에 `--ff-only`로 따라간다. dirty, local ahead, diverged 결과는 자동 복구 대상이 아니므로 위 절차로 사용자 변경을 먼저 보존한다.

## wrong branch, detached HEAD, upstream 없음

```powershell
git switch main
git branch --set-upstream-to=origin/main main
node scripts/config_cli.mjs check
```

현재 작업 commit을 버리거나 reset하지 않는다. 다른 branch의 작업은 먼저 별도 backup/commit으로 보존한다.

## stale process lock

동기화기는 lock이 30분보다 오래됐고 기록된 owner process가 종료된 경우에만 자동 회수한다. 수동 삭제 전에도 모든 `auto_sync.py` process가 종료됐는지 확인한다. active process가 있는 동안 `.git/print-drive-sync.lock`을 삭제하면 두 process가 동시에 commit할 수 있다.

`.print-drive-vault.lock`은 암호화·migration·rotation의 공통 writer lock이며 안전을 위해 자동 회수하지 않는다. 이 파일이 남았다면 모든 Print Drive Python/Node writer가 종료됐는지 작업 관리자에서 확인하고 encrypted output을 backup한 뒤 lock 파일만 제거한다. 그 후 `node check_public_files.mjs`와 `npm run verify`를 실행한다. 실행 중인 writer의 lock을 지우면 generation이 경합할 수 있다.

## encryption 또는 migration 중단

v2 writer는 새 blob과 manifest를 staging/publish하고 검증 뒤 garbage collection한다. 실패 뒤에는 다음을 수행한다.

```powershell
node check_public_files.mjs
node encrypt_files.mjs
node check_public_files.mjs
```

v1 migration 전에 만든 backup을 유지한다. migration 결과가 검증되지 않으면 `files/`를 수동 조합하지 말고 전체 encrypted-output backup을 한 단위로 복원한다. passphrase 변경도 manifest와 password file backup을 함께 취급한다.

passphrase와 모든 usable key backup을 잃으면 암호문을 복구할 수 없다. repository의 암호문만으로 password를 재설정할 수 있다는 안내를 하지 않는다.

## Pages 배포 rollback

CI build/guard가 실패하면 deploy job은 실행되지 않아 기존 Pages artifact가 유지된다. 이미 잘못된 commit이 main에 들어갔다면 history를 rewrite하지 말고 정상 commit을 새 revert commit으로 되돌린 뒤 verify/deploy를 다시 실행한다.

```powershell
git revert <bad-commit>
git push origin main
```

revert 전 encrypted manifest와 blob 집합이 같은 version의 일관된 snapshot인지 확인한다.

배포 뒤 앱 shell과 vault가 섞인 것처럼 보이면 먼저 `build-meta.json`, HTML build ID, service-worker cache ID가 같은지 확인한다. 새 bootstrap은 소유 cache와 stale worker를 한 번 정리하고 동일 transition을 반복 reload하지 않는다. 그래도 복구되지 않으면 탭을 닫고 사이트 데이터의 Print Drive worker/cache만 정리한 뒤 새 탭에서 다시 연다. 개별 `.bin`을 임의 교체하지 말고 `npm run verify:production`으로 공개 size/hash와 가능한 실제 복호화를 구분해 확인한다.

## 휴대형 업데이터 충돌·중단

- `BASE_SHA_CHANGED` 또는 ref conflict: 원격을 바꾸지 말고 새 snapshot/preview부터 다시 시작한다.
- blob upload 또는 tree/commit 생성 중단: branch ref는 기존 commit을 가리킨다. 재실행해 새 계획을 만든다. 도달 불가능한 Git object는 저장소 상태가 아니다.
- branch protection 거절: UI의 fallback으로 임시 branch와 PR을 만든다. PR merge와 Pages 검증 전에는 배포 완료가 아니다.
- token 권한 오류: token을 설정 파일에 넣지 말고 GitHub App 설치/SSO/Contents·Pull requests 권한을 고친 뒤 프로세스를 재시작한다.
- vault ID 불일치 또는 100 MiB blob 초과: 제한을 우회하지 않는다. 올바른 설정을 받거나 파일을 안전하게 분할한다.

## 평문 또는 secret이 Git history에 들어간 경우

2026-07-18 감사에서 과거 Git 이력에 평문 확장자의 `files/` 경로 11개와 Git으로 복구 가능한 blob이 확인되었다. 현재 tree에서 삭제했거나 암호화본으로 교체했더라도 과거 내용은 이미 공개된 것으로 취급한다. `npm run check`는 이 알려진 path 집합의 익명 digest를 고정해 추가 누출을 탐지하지만, 다른 이름의 blob content 부재까지 증명하지는 않는다.

먼저 다음을 수행한다.

1. repository 접근을 제한하고 노출된 password/token을 즉시 rotate 또는 revoke
2. `git clone --mirror`로 별도 offline backup 생성
3. 영향 commit, branch, tag, fork, Pages artifact, Actions artifact 범위 조사
4. 협업자와 maintenance window 합의

단, v2의 일반 password rotation은 VMK를 유지하므로 과거 password가 노출된 사고에서는 revocation이 아니다. 완전한 source snapshot에서 새 password와 새 VMK로 모든 blob을 새 encrypted-output generation에 재생성하고, 검증 뒤 새 저장소로 이전하거나 승인된 history 정화와 함께 배포한다. 과거 password로 열 수 있었던 파일은 이미 노출된 것으로 분류한다.

History 정화가 반드시 필요할 때만 별도 clone에서 `git filter-repo`를 사용한다. 예시 path는 실제 확인된 대상 하나로 교체해야 한다.

```powershell
git filter-repo --path <confirmed-leaked-path> --invert-paths
```

그 뒤 모든 branch/tag를 force push하면 commit ID가 바뀌고 열린 PR, fork, local clone, Pages 배포, 링크가 영향을 받는다. 원격 backup과 승인 없이 실행하지 않는다. 협업자는 old clone을 계속 push하지 말고 새로 clone해야 한다.

공개 fork/cache까지 확산됐거나 rewrite 영향이 과도하면 새 private repository로 이전하고 새 Pages URL을 발급하는 편이 더 안전할 수 있다. 어느 경우든 leak된 credential rotation은 history rewrite와 별개로 필요하다.
