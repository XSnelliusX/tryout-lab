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
| [Decoding](docs/decode.md) and [encoding](docs/encode.md) | Request parsing and response formatting |
| [Inspecting Redis traffic](docs/redis-traffic.md) | Observed requests and replies using tcpdump and Wireshark |
| [GET and SET](docs/commands.md) | Command syntax, behavior, responses, errors, and examples |
| [Architecture](docs/architecture.md) | Expected Kubernetes deployment, request flow, Go module responsibilities, and in-memory data model |
| [Docker](docs/docker.md) | Container image choices, Docker build stages, and local testing |
| [Kubernetes deployment](docs/kubernetes.md) | Namespace and local deployment learning steps |
| [Store and TDD](docs/store.md) | Store behavior, concurrency, and tests |

## Run locally

From this project directory, run the server with Go, or build and run the [Docker image](docs/docker.md):

```bash
# Run with Go
go run .

# Or build and run with Docker
docker build -t redis-server:local .
docker run --rm -p 127.0.0.1:6379:6379 redis-server:local
```

For Kubernetes, build the image first and ensure it is available to the local cluster. From this project directory:

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -n redis-lab -f k8s/deployment.yaml
kubectl apply -n redis-lab -f k8s/service.yaml
kubectl rollout status deployment/redis-server -n redis-lab
```

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
