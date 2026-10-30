# Benchmark results

The benchmark was run with:

```bash
redis-benchmark -h 127.0.0.1 -p 6379 -t set,get -n 1000000 --threads 4 -c 100
```

(The four threads belong to the benchmark client; the server handles connections using Go goroutines.)

## Results

| Metric | SET | GET |
| --- | ---: | ---: |
| Completed requests | 1,000,000 | 1,000,000 |
| Duration | 17.01 s | 16.51 s |
| Throughput | 58,782.04 requests/s | 60,569.35 requests/s |
| Average latency | 1.632 ms | 1.580 ms |
| Minimum latency | 0.304 ms | 0.312 ms |
| p50 latency | 1.503 ms | 1.447 ms |
| p95 latency | 2.783 ms | 2.703 ms |
| p99 latency | 3.991 ms | 3.983 ms |
| Maximum latency | 14.295 ms | 14.623 ms |

In this recorded run, GET throughput was higher than SET throughput. Both commands had p99 latency below 4 ms.

## CONFIG warning

The output starts with `WARNING: Could not fetch server CONFIG`. This implementation handles only `GET` and `SET`. The `CONFIG` command is not implemented and returns an unknown-command error in [handler.go](../commands/handler.go). The warning is consistent with that unsupported command. The output nevertheless records completed SET and GET workloads and their results.

## Full output

```text
WARNING: Could not fetch server CONFIG
====== SET ======
  1000000 requests completed in 17.01 seconds
  100 parallel clients
  3 bytes payload
  keep alive: 1
  multi-thread: yes
  threads: 4

Latency by percentile distribution:
0.000% <= 0.311 milliseconds (cumulative count 1)
50.000% <= 1.503 milliseconds (cumulative count 502993)
75.000% <= 1.871 milliseconds (cumulative count 752935)
87.500% <= 2.239 milliseconds (cumulative count 875797)
93.750% <= 2.647 milliseconds (cumulative count 938136)
96.875% <= 3.095 milliseconds (cumulative count 968955)
98.438% <= 3.615 milliseconds (cumulative count 984493)
99.219% <= 4.207 milliseconds (cumulative count 992211)
99.609% <= 4.831 milliseconds (cumulative count 996097)
99.805% <= 5.583 milliseconds (cumulative count 998063)
99.902% <= 6.503 milliseconds (cumulative count 999024)
99.951% <= 7.375 milliseconds (cumulative count 999513)
99.976% <= 8.159 milliseconds (cumulative count 999757)
99.988% <= 9.119 milliseconds (cumulative count 999878)
99.994% <= 10.039 milliseconds (cumulative count 999939)
99.997% <= 11.287 milliseconds (cumulative count 999971)
99.998% <= 12.375 milliseconds (cumulative count 999985)
99.999% <= 13.535 milliseconds (cumulative count 999993)
100.000% <= 13.583 milliseconds (cumulative count 999997)
100.000% <= 14.151 milliseconds (cumulative count 999999)
100.000% <= 14.295 milliseconds (cumulative count 1000000)
100.000% <= 14.295 milliseconds (cumulative count 1000000)

Cumulative distribution of latencies:
0.000% <= 0.103 milliseconds (cumulative count 0)
0.004% <= 0.407 milliseconds (cumulative count 42)
0.044% <= 0.503 milliseconds (cumulative count 439)
0.236% <= 0.607 milliseconds (cumulative count 2361)
0.780% <= 0.703 milliseconds (cumulative count 7798)
2.178% <= 0.807 milliseconds (cumulative count 21781)
4.727% <= 0.903 milliseconds (cumulative count 47274)
9.181% <= 1.007 milliseconds (cumulative count 91814)
15.038% <= 1.103 milliseconds (cumulative count 150376)
23.039% <= 1.207 milliseconds (cumulative count 230390)
31.562% <= 1.303 milliseconds (cumulative count 315620)
41.352% <= 1.407 milliseconds (cumulative count 413523)
50.299% <= 1.503 milliseconds (cumulative count 502993)
59.014% <= 1.607 milliseconds (cumulative count 590140)
65.872% <= 1.703 milliseconds (cumulative count 658715)
72.108% <= 1.807 milliseconds (cumulative count 721081)
76.766% <= 1.903 milliseconds (cumulative count 767658)
80.896% <= 2.007 milliseconds (cumulative count 808962)
84.072% <= 2.103 milliseconds (cumulative count 840716)
96.931% <= 3.103 milliseconds (cumulative count 969314)
99.120% <= 4.103 milliseconds (cumulative count 991197)
99.701% <= 5.103 milliseconds (cumulative count 997009)
99.870% <= 6.103 milliseconds (cumulative count 998698)
99.940% <= 7.103 milliseconds (cumulative count 999401)
99.974% <= 8.103 milliseconds (cumulative count 999741)
99.988% <= 9.103 milliseconds (cumulative count 999876)
99.994% <= 10.103 milliseconds (cumulative count 999939)
99.996% <= 11.103 milliseconds (cumulative count 999960)
99.998% <= 12.103 milliseconds (cumulative count 999984)
99.999% <= 13.103 milliseconds (cumulative count 999990)
100.000% <= 14.103 milliseconds (cumulative count 999998)
100.000% <= 15.103 milliseconds (cumulative count 1000000)

Summary:
  throughput summary: 58782.04 requests per second
  latency summary (msec):
          avg       min       p50       p95       p99       max
        1.632     0.304     1.503     2.783     3.991    14.295
====== GET ======
  1000000 requests completed in 16.51 seconds
  100 parallel clients
  3 bytes payload
  keep alive: 1
  multi-thread: yes
  threads: 4

Latency by percentile distribution:
0.000% <= 0.319 milliseconds (cumulative count 1)
50.000% <= 1.447 milliseconds (cumulative count 500989)
75.000% <= 1.799 milliseconds (cumulative count 753015)
87.500% <= 2.159 milliseconds (cumulative count 876144)
93.750% <= 2.559 milliseconds (cumulative count 938003)
96.875% <= 3.031 milliseconds (cumulative count 968894)
98.438% <= 3.575 milliseconds (cumulative count 984394)
99.219% <= 4.223 milliseconds (cumulative count 992194)
99.609% <= 4.919 milliseconds (cumulative count 996096)
99.805% <= 5.751 milliseconds (cumulative count 998056)
99.902% <= 6.407 milliseconds (cumulative count 999024)
99.951% <= 7.167 milliseconds (cumulative count 999512)
99.976% <= 7.919 milliseconds (cumulative count 999756)
99.988% <= 8.935 milliseconds (cumulative count 999878)
99.994% <= 9.871 milliseconds (cumulative count 999941)
99.997% <= 10.671 milliseconds (cumulative count 999970)
99.998% <= 11.591 milliseconds (cumulative count 999985)
99.999% <= 11.759 milliseconds (cumulative count 999993)
100.000% <= 11.847 milliseconds (cumulative count 999997)
100.000% <= 12.087 milliseconds (cumulative count 999999)
100.000% <= 14.623 milliseconds (cumulative count 1000000)
100.000% <= 14.623 milliseconds (cumulative count 1000000)

Cumulative distribution of latencies:
0.000% <= 0.103 milliseconds (cumulative count 0)
0.005% <= 0.407 milliseconds (cumulative count 48)
0.049% <= 0.503 milliseconds (cumulative count 494)
0.261% <= 0.607 milliseconds (cumulative count 2608)
0.918% <= 0.703 milliseconds (cumulative count 9175)
2.578% <= 0.807 milliseconds (cumulative count 25780)
5.610% <= 0.903 milliseconds (cumulative count 56096)
10.826% <= 1.007 milliseconds (cumulative count 108263)
17.510% <= 1.103 milliseconds (cumulative count 175098)
26.502% <= 1.207 milliseconds (cumulative count 265022)
35.823% <= 1.303 milliseconds (cumulative count 358234)
46.265% <= 1.407 milliseconds (cumulative count 462655)
55.192% <= 1.503 milliseconds (cumulative count 551921)
63.727% <= 1.607 milliseconds (cumulative count 637267)
70.094% <= 1.703 milliseconds (cumulative count 700938)
75.682% <= 1.807 milliseconds (cumulative count 756821)
79.844% <= 1.903 milliseconds (cumulative count 798442)
83.462% <= 2.007 milliseconds (cumulative count 834623)
86.220% <= 2.103 milliseconds (cumulative count 862200)
97.187% <= 3.103 milliseconds (cumulative count 971867)
99.116% <= 4.103 milliseconds (cumulative count 991162)
99.671% <= 5.103 milliseconds (cumulative count 996709)
99.851% <= 6.103 milliseconds (cumulative count 998509)
99.947% <= 7.103 milliseconds (cumulative count 999471)
99.980% <= 8.103 milliseconds (cumulative count 999796)
99.989% <= 9.103 milliseconds (cumulative count 999887)
99.996% <= 10.103 milliseconds (cumulative count 999958)
99.998% <= 11.103 milliseconds (cumulative count 999977)
100.000% <= 12.103 milliseconds (cumulative count 999999)
100.000% <= 15.103 milliseconds (cumulative count 1000000)

Summary:
  throughput summary: 60569.35 requests per second
  latency summary (msec):
          avg       min       p50       p95       p99       max
        1.580     0.312     1.447     2.703     3.983    14.623
```
