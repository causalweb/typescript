# Order reference resource measurements

Status: local storage/SDK-path samples, not a capacity limit or production benchmark. Run from the TypeScript repository after `npm ci --ignore-scripts`:

```sh
npm run measure:reference -- 1000
```

The script creates disposable source and view SQLite databases with WAL and `synchronous = FULL`, then repeatedly commits a distinct order, issues ES256 evidence, stores it in the source outbox, verifies it with the public SDK, applies the event in the view, and marks source delivery acknowledged. It checks the final state-bound frontier and representation. It records wall time, phase times, sampled process RSS, and database file sizes after closing both connections. The CLI accepts 1–5000 orders; it does not retain test databases or credentials.

This workload runs both stores in **one process** without HTTPS, network delivery, concurrent clients, process restarts, backup, or application authentication. It measures neither the reference service's end-to-end throughput nor a safe maximum deployment size. RSS is sampled once per order and may miss a shorter peak; database sizes exclude WAL files after close. Results vary with machine, filesystem, cache state, and background load.

## Local sample, 2026-10-18

One run per count on Windows 10.0.26200, 12th Gen Intel Core i5-12400F, Node.js v24.18.0, **before** the view delivery scan was changed to stream positions instead of allocating all order rows:

| Orders | Total time | Orders/s | Commit | Issue and store | Verify | View apply and acknowledge | Sampled peak RSS | Source DB | View DB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 0.56 s | 180 | 0.15 s | 0.13 s | 0.03 s | 0.25 s | 69 MB | 115 kB | 127 kB |
| 500 | 2.64 s | 190 | 0.59 s | 0.63 s | 0.13 s | 1.28 s | 77 MB | 471 kB | 483 kB |
| 1000 | 6.01 s | 166 | 1.27 s | 1.39 s | 0.32 s | 3.01 s | 88 MB | 918 kB | 930 kB |
| 2000 | 13.49 s | 148 | 2.72 s | 2.91 s | 0.62 s | 7.19 s | 130 MB | 1806 kB | 1819 kB |

The view apply phase takes an increasing share as history grows. A code-level explanation is that `OrderViewStore.accept` calls `readViewCut`, which scans every applied position to re-check contiguous lineage for each accepted event. That is an **inference from the implementation**, not a performance regression proven by one sample. It preserves a fail-closed check for lost lineage, so replacing it requires an equally trustworthy state-bound integrity mechanism and a migration test; simply skipping the scan to raise throughput would weaken the protocol claim.

The current code streams only positions during delivery; a representation read still collects the order rows it returns. One further run at each count after that change:

| Orders | Total time | Orders/s | View apply and acknowledge | Sampled peak RSS |
| ---: | ---: | ---: | ---: | ---: |
| 1000 | 5.55 s | 180 | 2.89 s | 81 MB |
| 2000 | 12.86 s | 156 | 7.17 s | 89 MB |

The lower sampled RSS is consistent with fewer temporary row allocations, but one before/after run cannot isolate that effect from runtime or filesystem variation. The apply time remains material and still grows with history. A regression test corrupts one applied position while preserving the row count; the view continues to report `unknown`, so the optimization did not replace contiguous-lineage validation with a mere count check.

An expression-index trial on `view_orders(length(position), position)` removed SQLite's temporary order-by B-tree in `EXPLAIN QUERY PLAN`, but did not establish a useful end-to-end gain. On the same host, one 2,000-order trial with the index took 24.75 s total (15.89 s in view apply), versus the earlier unindexed 12.86 s sample (7.17 s in view apply). An in-memory 2,000-insert/full-prefix-scan A/B repeated twice measured unindexed 5.23/5.25 s and indexed 5.69/4.57 s; the mixed result and differing trial conditions cannot support a speedup claim. The index was removed from the working implementation. It would add stored state and migration work without addressing the fundamental full-prefix rescan; a future change needs repeated comparable service measurements and preserved corruption detection.

Before a deployment or sizing recommendation, repeat measurements on the target filesystem and host with both HTTPS services as separate processes, concurrent readers/writers, realistic response sizes, authenticated delivery, restarts, and sustained load. Record latency distributions, service-process RSS, WAL growth, CPU, disk sync behavior, and failure rates. No throughput or memory SLO is claimed here.

## Two-process localhost HTTPS sample

The local quickstart also has a measurement mode:

```sh
npm run measure:service -- 300
```

It first proves a stale `412` and a confirmed `200`, then sends the requested number of distinct writes sequentially to the HTTPS source. The source asynchronously delivers authenticated events to a separate HTTPS view process. The harness polls a constrained view read carrying the last evidence until it confirms all writes. `confirmedMs` starts at the first measured write and ends at that final confirmed response; the two initial quickstart orders are outside the requested count. Each run uses fresh temporary databases, a generated signing key and credentials, and the repository's **test-only localhost certificate**. Both processes stop and the files are removed afterward.

One run per count on the same Windows/Node host as above:

| Additional orders | Writes complete | Final confirmation | Confirmed orders/s | Write p50 | Write p95 | Confirmation polls |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 0.52 s | 2.26 s | 44 | 4.9 ms | 7.2 ms | 29 |
| 300 | 2.03 s | 5.01 s | 60 | 5.6 ms | 11.0 ms | 49 |
| 500 | 2.05 s | 7.37 s | 68 | 3.9 ms | 6.2 ms | 85 |

These are one-off samples, not steady-state rates; notably the 500-write submission phase was faster than the 300-write run, so the numbers should not be extrapolated as a scaling curve. The source delivers while writes are still arriving, and confirmation includes polling and the view returning the entire order list. This mode does not sample child-process memory/CPU, vary concurrent clients, use an operator certificate, or hold load long enough to establish an SLO. It cannot justify a deployment sizing recommendation.

## Operator-decision history read sample

A separate local probe on 2026-10-18 used Node.js v24.18.0 on Windows 10.0.26200. Reproduce it with `npm run measure:failure-history`. It opens one view database with a fixture pending position 2 and inserts alternating `failed`/`resolved` decisions for that position directly in one SQLite transaction. Each row has the reference contract, schema, and operator fields. The probe calls `snapshot()` 100 times at each history length and divides elapsed wall time by 100. It measures the view read path only, not operator-command writes, network responses, or competing traffic.

| Decision events | Mean `snapshot()` time |
| ---: | ---: |
| 0 | 0.033 ms |
| 200 | 0.433 ms |
| 1,000 | 1.884 ms |
| 5,000 | 11.025 ms |

The current reader scans the decision history to validate scope and reconstruct the latest action per position. These samples are consistent with that linear work; one run does not establish a latency curve or safe history limit. The fixture pending event bypasses delivery authentication, and direct insertion bypasses the operator command. This probe says nothing about decision-write throughput or whether an operator correctly classified an incident. A future sizing claim needs a two-process workload with realistic decision retention, concurrent reads, latency distributions, and a target SLO. No failure-history size or read-latency bound is certified.
