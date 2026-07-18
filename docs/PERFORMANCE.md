# Performance validation

2026-07-18 Windows, Node 24, OneDrive workspace에서 `npm run benchmark`로 측정했습니다. Synthetic vault는 PBKDF2 200,000회와 padding 0을 사용했습니다. 시간과 RSS는 filesystem, antivirus, process GC 상태에 민감합니다. `peak RSS`는 각 scenario 실행 중 5ms 간격으로 관측한 process RSS이며, 같은 process를 재사용하므로 앞 scenario가 확보한 memory가 남을 수 있습니다.

`source bytes`는 hash와 변경 파일 암호화를 위해 읽은 bytes의 합입니다. 따라서 최초/변경 암호화는 현재 source를 두 번 읽고, fast-path no-op은 읽지 않습니다. `manifest`는 encrypted envelope byte 변경 여부입니다.

| scenario | ms | source hashed | source bytes | blobs decrypted | new blobs | manifest | peak RSS |
|---|---:|---:|---:|---:|---:|---|---:|
| initial 100 | 2,558.0 | 100 | 829,100 | 100 | 100 | changed | 115,773,440 B |
| no-op 100 | 315.9 | 0 | 0 | 0 | 0 | same | 56,893,440 B |
| modify 1/100 | 259.4 | 1 | 16,384 | 1 | 1 | changed | 97,988,608 B |
| add 1 | 279.5 | 1 | 10,000 | 1 | 1 | changed | 128,765,952 B |
| delete 1 | 314.4 | 0 | 0 | 0 | 0 | changed | 106,459,136 B |
| rename 1 | 255.0 | 1 | 4,104 | 0 | 0 | changed | 102,002,688 B |
| password rotation | 208.5 | 0 | 0 | 0 | 0 | changed | 60,989,440 B |
| full audit 100 | 250.1 | 100 | 419,501 | 100 | 0 | same | 129,343,488 B |
| initial 100 MiB | 1,379.6 | 1 | 209,715,200 | 1 | 1 | changed | 479,178,752 B |
| no-op 100 MiB | 58.4 | 0 | 0 | 0 | 0 | same | 376,602,624 B |
| modify 100 MiB | 3,048.5 | 1 | 209,715,200 | 1 | 1 | changed | 476,725,248 B |

핵심 합격 결과는 100-file no-op에서 full source hash 0, source read 0 B, blob decrypt 0, new blob 0, manifest byte 변경 없음입니다. 한 파일 수정은 full source hash 1, new blob 1, unchanged blob 99입니다. 삭제는 source read 없이 manifest와 object 집합만 바꾸고, rename은 새 이름의 source 하나를 hash한 뒤 기존 immutable blob을 재사용합니다. `--full-scan --verify-all`은 source 100개와 blob 100개를 명시적으로 audit하면서 manifest를 바꾸지 않았습니다.

## Large-file limitation

v2 format과 transactional writer를 유지한 채 AES-GCM streaming을 도입하려면 AAD metadata 확정, padding, ciphertext hash, durable temporary file과 pre-commit authentication 경계를 함께 바꿔야 합니다. 이번 pass에서는 format 안정성을 우선해 streaming rewrite를 하지 않았습니다. Source는 1MiB chunk로 hash하고 파일을 한 번에 하나씩 처리하지만, 변경된 큰 파일은 암호화와 인증 중 source/ciphertext/plaintext Buffer가 겹칩니다. 실제 100 MiB initial/modify sampled peak RSS는 약 479 MB/477 MB였습니다.

따라서 512 MiB format 상한은 저사양 기기의 권장 운용 크기가 아닙니다. 큰 파일은 충분한 memory가 있는 신뢰 기기에서 처리하고, browser update/decrypt의 보수적 256 MiB 상한을 유지합니다. 후속 streaming 작업은 v2 byte interoperability와 transaction failpoint test를 먼저 고정한 별도 변경으로 다뤄야 합니다.

## 폴더와 휴대형 업데이터 비용

재귀 source scan은 directory entry와 안전한 상대 경로를 모두 확인하지만 fingerprint가 유지된 파일은 기존과 같이 content hash/read를 생략합니다. rename/move는 새 경로의 파일을 hash해 유일한 size/SHA-256 대응을 찾은 뒤 ciphertext blob을 재사용합니다. 폴더 구조 자체는 plaintext manifest가 아니라 암호화 manifest 안의 `relativePath`에만 들어갑니다.

휴대형 업데이터는 정확한 Git tree snapshot을 만들기 위해 원격 `files/` blob을 읽고, 현재 구현은 대상 encrypted file map을 메모리에 보관합니다. 각 Git blob은 100 MiB를 넘기 전에 거부되며 브라우저 전체 ZIP은 5,000개·평문 합계 512 MiB 상한을 유지합니다. 매우 큰 vault는 충분한 RAM과 안정된 네트워크가 있는 신뢰 기기에서 처리해야 하며, GitHub API 호출·memory를 줄이는 unchanged Git-blob 재사용 최적화는 후속 과제입니다.
