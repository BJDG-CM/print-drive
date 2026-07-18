# Performance validation

2026-07-18에 Windows, Node 24, OneDrive workspace에서 synthetic data로 측정했습니다. 두 구현 모두 PBKDF2 200,000회와 padding 0을 사용했습니다. v1은 이 작업 branch의 부모 commit 구현을 격리 clone에서 실행했고, v2는 `npm run benchmark`를 실행했습니다. 시간은 filesystem, antivirus, OneDrive 상태에 민감하므로 상대적인 암호문 churn과 upload proxy를 우선해서 봅니다.

`transfer proxy`는 새/변경 immutable blob과 새 `manifest.enc` bytes의 합이며 Git pack compression, 삭제 전달 비용과 실제 네트워크 protocol은 모델링하지 않습니다. `manifest.enc changed`는 encrypted manifest body만이 아니라 공개 envelope/key slot을 포함한 파일 전체 hash입니다. RSS는 scenario별 독립 peak가 아니라 각 process의 누적 high-water mark입니다.

| scenario | v1 ms | v1 changed blobs | v1 transfer proxy | v2 ms | v2 changed blobs | v2 transfer proxy |
|---|---:|---:|---:|---:|---:|---:|
| initial 100 | 3214.4 | 100 | 462,701 B | 3869.6 | 100 | 520,384 B |
| no-op 100 | 1754.6 | 100 | 462,701 B | 551.0 | 0 | 0 B |
| modify 1/100 | 484.6 | 100 | 466,755 B | 1492.3 | 1 | 112,442 B |
| add 1 | 531.9 | 101 | 472,231 B | 3463.9 | 1 | 110,279 B |
| delete 1 | 530.6 | 100 | 467,652 B | 2875.7 | 0 | 104,234 B |
| rename 1 | 2546.2 | 100 | 467,656 B | 3238.4 | 0 | 104,238 B |
| password rotation | 461.3 | 100 | 467,656 B | 420.6 | 0 | 104,238 B |
| initial 101 MiB | 1303.1 | 1 | 105,907,239 B | 7586.9 | 1 | 105,908,519 B |
| no-op 101 MiB | 344.8 | 1 | 105,907,239 B | 416.2 | 0 | 0 B |

전체 run의 process high-water RSS는 v1 465,244 KiB, v2 573,812 KiB였습니다. v2는 source fingerprint를 1 MiB chunk로 hash하고 여러 source bytes를 한꺼번에 보관하지 않지만, 101 MiB object의 AES-GCM 암호화와 두 번의 완전 검증은 여전히 큰 Buffer를 사용합니다. 따라서 100 MiB+ 처리 성능과 memory는 남은 개선 항목이며, 현재 512 MiB format 상한을 “저사양 기기에서 안전한 운용 크기”로 해석하면 안 됩니다.

핵심 합격 결과는 v2 no-op upload proxy 0, 100개 중 1개 수정 시 새 blob 1개, add 시 새 blob 1개, delete/rename 시 새 blob 0개, password rotation 시 blob 0개입니다. 그 대가로 durable staging, fsync, 전체 인증 검증 때문에 일부 작은 변경의 wall time은 v1보다 길었습니다.
