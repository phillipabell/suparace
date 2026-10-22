| Op | Method | N | Runs | Items | Successes (mean) | Violations mean / max | Left unclaimed max | Lost updates mean | Errors | Wall ms (mean) | Calls/s (mean) | p50 ms | p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claim | naive | 10 | 5 | 5 | 10 | 9 / 9 | 4 | - | 0 | 34 | 293 | 23.2 | 34.0 |
| claim | atomic_update | 10 | 5 | 5 | 1 | 0 / 0 | 4 | - | 0 | 33 | 312 | 21.3 | 33.2 |
| claim | pgmq | 10 | 5 | 5 | 5 | 0 / 0 | 0 | - | 0 | 9 | 1078 | 6.7 | 9.3 |
| claim | skip_locked | 10 | 5 | 5 | 5 | 0 / 0 | 0 | - | 0 | 9 | 1171 | 6.0 | 8.5 |
| claim | naive | 100 | 5 | 50 | 100 | 89 / 90 | 40 | - | 0 | 252 | 406 | 158.4 | 239.9 |
| claim | atomic_update | 100 | 5 | 50 | 25 | 0 / 0 | 26 | - | 0 | 155 | 648 | 88.0 | 147.4 |
| claim | pgmq | 100 | 5 | 50 | 50 | 0 / 0 | 0 | - | 0 | 73 | 1407 | 50.6 | 72.0 |
| claim | skip_locked | 100 | 5 | 50 | 50 | 0 / 0 | 0 | - | 0 | 62 | 1610 | 48.9 | 61.4 |
| spend | naive | 10 | 5 | 5 | 10 | 5 / 5 | - | 9 | 0 | 32 | 313 | 20.8 | 31.9 |
| spend | conditional_update | 10 | 5 | 5 | 5 | 0 / 0 | - | 0 | 0 | 31 | 324 | 19.2 | 30.8 |
| spend | for_update | 10 | 5 | 5 | 5 | 0 / 0 | - | 0 | 0 | 31 | 319 | 20.0 | 31.4 |
| spend | naive | 100 | 5 | 50 | 100 | 50 / 50 | - | 97 | 0 | 344 | 292 | 185.8 | 332.0 |
| spend | conditional_update | 100 | 5 | 50 | 50 | 0 / 0 | - | 0 | 0 | 203 | 500 | 173.2 | 190.6 |
| spend | for_update | 100 | 5 | 50 | 50 | 0 / 0 | - | 0 | 0 | 343 | 295 | 177.2 | 329.1 |
