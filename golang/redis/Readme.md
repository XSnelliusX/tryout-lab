# Redis-like Server in Go

A learning project: build a small, in-memory key-value server in Go that accepts Redis-style `GET` and `SET` commands over TCP using the Redis Serialization Protocol (RESP).

The goal is to use **Go goroutines and channels** to build a single server and understand the path from bytes arriving on a connection to a stored value and a correctly encoded response—not to recreate all of Redis.

## Expected results

1. A system diagram explaining the server architecture.
2. An explanation from the network layer down to the Go functions handling a request.
3. A working `GET`/`SET` demonstration using `redis-cli`.
4. A documented workload and results using `redis-benchmark`.
5. A deployment to a local Kubernetes cluster.

## Initial scope

- Accept RESP command arrays containing bulk strings over TCP.
- Implement `SET key value` and `GET key` for string values.
- Keep one shared, in-memory store for connected clients.
- Distinguish a missing key from a key containing an empty value.
- Return RESP replies for success, missing values, and command errors.
- Start locally, add concurrent clients, then package and deploy to a local Kubernetes cluster.

Initially out of scope: full Redis compatibility, inline commands, persistence, expiration, authentication, TLS, replication, clustering, and additional Redis data types.

> **Safety:** This is not a production database. Without authentication or TLS, keep it local in an isolated development environment. All stored data will disappear when the process stops.

## Documentation map

| Topic | What to document |
| --- | --- |
| [RESP](docs/resp.md) | Wire format, byte lengths, request framing, and decoder/encoder notes |
| [Inspecting Redis traffic](docs/redis-traffic.md) | Observed requests and replies using tcpdump and Wireshark |
| [GET and SET](docs/commands.md) | Command syntax, behavior, responses, errors, and examples |

## First manual scenario

Once a server is running on `127.0.0.1:6379`, these are the results this project should reproduce. The [traffic capture](docs/redis-traffic.md) shows the bytes behind the `SET` and `GET` examples.

```bash
redis-cli -2 -h 127.0.0.1 -p 6379 SET greeting hello
# Expected: OK

redis-cli -2 -h 127.0.0.1 -p 6379 GET greeting
# Expected: "hello"

redis-cli -2 -h 127.0.0.1 -p 6379 GET missing
# Expected: (nil)
```
