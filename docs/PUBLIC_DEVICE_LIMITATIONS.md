# Public-device limitations

## 권장 흐름

공용 기기에서는 전체 vault unlock을 선택하지 말고 신뢰 기기에서 만든 v2 파일별 capability를 사용합니다. 링크 자체가 해당 파일의 bearer 권한이며 password 없이 열립니다. 신뢰 채널로 전달하고, 전달 뒤에는 복사·screenshot·clipboard 기록을 회수할 수 없다고 가정합니다.

fragment는 서버 request와 Referrer에 포함되지 않으며 head bootstrap이 읽은 즉시 현재 주소에서 제거합니다. 이것은 이미 링크를 본 extension, clipboard, screenshot, browser sync 또는 수신자를 막지 않습니다. client 표시 만료와 2분 idle 종료는 UI/key lifetime을 줄이지만 static Pages는 만료·사용 횟수·회수를 서버에서 강제하지 못합니다.

public mode는 trusted 작업을 취소하고 service worker를 등록하지 않으며 late registration을 해제합니다. 선택 파일 object만 same-origin/no-referrer로 가져오고 무결성을 검증한 후 표시합니다. master key와 다른 file DEK는 capability에 포함되지 않습니다.

현재 browser decrypt 상한은 encrypted object 256 MiB입니다. 신뢰 기기 UI는 이 상한을 넘는 파일에 열리지 않는 capability 링크를 만들지 않습니다. 더 큰 파일은 신뢰 기기의 로컬 전달 절차를 사용해야 하며, 브라우저 streaming AEAD가 구현되기 전까지 public mode로 지원한다고 표시하지 않습니다.

## 종료가 정리하는 것

앱은 다음을 best effort로 정리하고 성공·실패·미지원 결과를 구분합니다.

- JS memory의 key/file reference와 preview DOM
- app prefix의 session/local storage, 알려진 IndexedDB, Cache Storage
- Print Drive service-worker registration과 cache-clear message
- preview/print/download object URL과 iframe
- URL의 capability fragment
- BFCache 복귀 시 민감 화면을 다시 표시하지 않는 safe exit/lock state

등록 해제된 service worker도 현재 page navigation이 끝날 때까지 controller로 남을 수 있습니다. browser API가 없거나 접근이 차단되면 정리 여부를 확인하지 못했다고 표시합니다.

## 앱이 정리할 수 없는 것

- 내려받은 파일과 browser download/visit/address-bar history
- clipboard의 공유 링크, screenshot, OS share-sheet 기록
- OS recent files, thumbnail/index/search cache
- printer/spooler/queue/audit 기록과 이미 열린 인쇄 dialog
- browser extension, sync provider, proxy 또는 관리 소프트웨어가 보관한 기록

사용 후 공유 링크가 든 clipboard를 다른 값으로 덮어쓰고, 다운로드 파일·browser session·printer queue를 직접 확인한 뒤 guest/private session과 탭을 닫으세요. private mode만으로 다운로드 파일이나 printer 기록이 자동 삭제된다고 가정하지 마세요.
