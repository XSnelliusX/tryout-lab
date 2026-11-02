# Redis Server \- Mini project

> **Summary: **This project was carried out to gain practical experience with concurrency in Go and with deploying a Go application to Kubernetes. For this, a small Redis-like key-value server was implemented because it covers both objectives.
>
> 1. Multiple clients access a shared state at the same time, which requires concurrency to be handled explicitly.
> 2. The server is a single binary listening on one TCP port, which makes it well suited for packaging as a container and deploying to a cluster.
>
> The server accepts Redis `GET` and `SET` commands over TCP using a subset of the Redis Serialization Protocol (RESP2). It is compatible with the standard `redis-cli` and `redis-benchmark` tools and was deployed to a local Kubernetes cluster, reaching a throughput of \~60,000 requests per second in a local benchmark.

## Results

| Objective | Result |
| --- | --- |
| Concurrent handling of clients | A dedicated goroutine is started for each TCP connection. All connections share one in-memory store. |
| Compatibility with the Redis protocol | RESP requests are decoded and responses encoded. The behavior was verified with `redis-cli` and by analyzing the traffic with Wireshark. |
| Safe access to shared state | The store is synchronized with a `sync.RWMutex`. It was developed test-first (TDD) and verified with the Go race detector. |
| Containerization | A multi-stage Docker image was created (Go build stage, Alpine runtime stage, non-root user). |
| Deployment | The server was deployed to a local Kubernetes cluster using a Namespace, a Deployment, and a LoadBalancer Service. |
| Performance measurement | A workload of 1,000,000 requests per command was executed with `redis-benchmark`. |

---

The recording below shows the server in operation. Three terminal windows are used:

| Window | Content | Purpose |
| --- | --- | --- |
| Left | `k9s` showing the live log of the server pod | Every request that arrives at the server is visible. |
| Upper right | `redis-cli`, session A | First client |
| Lower right | `redis-cli`, session B | Second client |

The two client sessions run a demo script, one per window. The sessions coordinate with each other through the server itself, so every step in one window depends on a value written in the other window. The following steps are shown:

| Step | Demonstrated behavior |
| --- | --- |
| 1 | Session A writes a key and session B reads it. State is shared between connections. |
| 2 | Session B overwrites the key and session A reads the new value. |
| 3 | An empty value (`""`) is distinguished from a missing key (`(nil)`). |
| 4 | Both sessions alternate writes on one key in three rounds (ping-pong). |
| 5 | Both sessions agree on a start time and then each sends 200 `SET` commands to the same key over its own connection. The server log shows the requests of both connections interleaved. Both sessions afterwards read the same final value. |
| 6 | Commands are case-insensitive. A wrong argument count and an unknown command return errors. |

[![Demo](../demo/redis-demo-thumb.png)](../demo/redis-demo.mp4)

## Traffic investigation

Before implementing the server, local Redis traffic was inspected using `tcpdump` and Wireshark. The capture showed that commands arrive as arrays of bulk strings, `SET` returns a simple string, and `GET` returns a bulk string.

```bash
sudo tcpdump -i lo0 -nn -s 0 -A 'tcp port 6379'
```

For `SET greeting hello`, the payload of the request looked like this. Every line ends with CRLF (`\\r\\n`):

```text
*3        array of 3 elements
$3        next bulk string has 3 bytes
SET       the command
$8        next bulk string has 8 bytes
greeting  the key
$5        next bulk string has 5 bytes
hello     the value
```

The server replied with `+OK` (simple string). The reply to `GET greeting` was `$5` followed by `hello` (bulk string).

Redis protocol investigation with Wireshark

## Architecture

The system consists of two layers. Kubernetes runs and exposes a single server pod. Within the pod, the Go server is divided into packages with clearly separated responsibilities.

The initial architecture including the planed Kubernetes deployment is shown in the diagram on the right side, while the actual architecture including the packages, their types, functions, and the dependencies between them can be seen below. The core idea of the initially planed architecture held up: a concurrent TCP server, a separate protocol layer, a command layer, and one lock-protected store.

![Initial Architecture](architecture-planned.svg)

![Implemented Architecture](architecture-actual.svg)

| Package | Responsibility |
| --- | --- |
| `main.go` | Parses flags and starts the server on port 6379 |
| `server/` | Creates the shared store and command handler. Accepts TCP connections and runs one goroutine per incoming connection. |
| `resp/` | Decodes request command arrays and encodes replies |
| `commands/` | Dispatches `GET` and `SET` , validates argument counts, and returns a typed command results |
| `store/` | Owns a string-to-string map and synchronizes its access |

The command layer does not access the network, and the RESP layer has no knowledge of command semantics. As a result, each layer can be reasoned about and tested separately

## Supported commands and errors

| Operation | Behavior | Reply |
| --- | --- | --- |
| `SET key value` | Creates or replaces a string value | Simple string `OK` |
| `GET key` for an existing key | Returns its value | Bulk string |
| `GET key` for a missing key | Reports absence, not an empty value | Null bulk string |
| `SET key ""`, followed by `GET` | Stores and retrieves an empty value | Empty bulk string |
| Wrong argument count | Rejects the command before accessing the store | Error |
| Unsupported command | Rejects the command | Error |

Command names are case-insensitive, while keys are case-sensitive. `GET` requires exactly two array elements, and `SET` requires exactly three. Additional `SET` options (such as `NX`, `XX`, or `EX`) are not implemented and are rejected as a wrong argument count.

Command results are separate from their wire representation. The command handler returns a result kind and a value. The RESP encoder decides how to format the reply. It escapes CR and LF in error text, rejects simple strings containing line breaks, and returns an error for unsupported result kinds. When encoding fails, the server closes that connection.

| Result kind | RESP type | Wire format | Produced by |
| --- | --- | --- | --- |
| `ReplySimpleString` | Simple string | `+OK\\r\\n` | Successful `SET` |
| `ReplyBulkString` | Bulk string | `$5\\r\\nhello\\r\\n` | `GET` of an existing key |
| `ReplyBulkString` (empty value) | Empty bulk string | `$0\\r\\n\\r\\n` | `GET` of a key holding `""` |
| `ReplyNoneBulkString` | Null bulk string | `$-1\\r\\n` | `GET` of a missing key |
| `ReplyError` | Error | `-ERR <message>\\r\\n` | Wrong argument count, unknown command, empty command |

## Request flow

![Request Flow](request-flow.svg)

1. A client connects to the Kubernetes LoadBalancer Service, routing the connection to the pod.
2. The connection is accepted by the TCP server, and a new goroutine is started for it.
3. The incoming bytes are read and decoded by the RESP layer into a command with its arguments, for example `["SET", "greeting", "hello"]`.
4. The command name and the number of arguments are validated by the command layer, and the store is read or written accordingly.
5. The result is encoded by the RESP layer (for example `+OK`, `$5 hello`, or `$-1`) and is written back to the client.
6. The connection remains open for further requests until it is closed by the client.

(When running directly with Go, the client connects to the server without the Kubernetes Service.)

## Concurrency in Go

Goroutines provide the concurrency, most data stays private to a single goroutine, a reader-writer mutex protects the one piece of shared state, and the tests and the race detector verify the result.

### One goroutine per connection

The server creates a single store and a single command handler before it starts accepting connections. Every accepted connection is then handed to its own goroutine:

```go
func StartServer(port string, verbose bool) {
	valueStore := store.NewStore()
	commandHandler := commands.NewHandler(valueStore)
	// ...
	for {
		conn, err := listener.Accept()
		// ...
		go handleConnection(conn, commandHandler, verbose)
	}
}
```

The accept loop never processes a request itself. It only accepts and delegates, so a slow or idle client cannot delay the acceptance of new clients. Requests within one connection are processed sequentially, while requests from different connections run concurrently.

The same `commandHandler` pointer is passed to every goroutine. This is safe because the handler holds no mutable state of its own. It contains only a pointer to the store, and the store is the single place where synchronization takes place.

### Data ownership: what is shared and what is not

| Data | Owner | Synchronization |
| --- | --- | --- |
| `net.Conn` | The goroutine of this connection | Not required |
| `bufio.Reader` | Created inside `connectionReadLoop`, used by one goroutine only | Not required |
| Decoded request (`[]string`) and encoded reply (`[]byte`) | Created per request inside the goroutine | Not required |
| `commands.Handler` | Shared pointer holding the store, not modified after creation | Not required |
| `store.Store` | Shared by all connection goroutines | `sync.RWMutex` |

```go
func connectionReadLoop(conn net.Conn, commandHandler *commands.Handler, verbose bool) {
	reader := bufio.NewReader(conn) // local to this goroutine
	for {
		decodedCommand, err := resp.DecodeRespRequest(reader)
		// ...
		resultObject := commandHandler.HandleCommand(decodedCommand) // only call that reaches shared state
		resultBytes, err := resp.Encode(resultObject)
		// ...
		_, err = conn.Write(resultBytes)
	}
}
```

Network reading, decoding, encoding, and writing all happen outside of any lock. Only `HandleCommand` leads to the store, and the lock exists only inside the store.

### Protecting the shared store

A Go map is not safe for concurrent use when at least one goroutine writes. The Go runtime itself detects concurrent map writes and terminates the entire process with a fatal error that cannot be recovered. In the server, a single unsynchronized write would therefore disconnect all clients. The store therefore combines the map and its mutex in one type, and the only way to reach the map is through two methods:

```go
type Store struct {
	mu       sync.RWMutex
	valueMap map[string]string
}

func (s *Store) Set(key string, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.valueMap[key] = value
}

func (s *Store) Get(key string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	val, exists := s.valueMap[key]
	return val, exists
}
```

Important design decisions:

- Reader-writer lock instead of a plain mutex
    - `Get` takes a read lock, so any number of readers can access the map at the same time. `Set` takes the write lock, which waits for all readers to finish and then excludes everybody else.
- `defer` for unlocking
    - The unlock is registered directly after the lock, so it is executed on every return path, including a panic. A forgotten unlock would block all other connections permanently.
- The lock is private and encapsulated:
    - The mutex and the map are unexported fields, so callers cannot access the map without the lock.
- Pointer receivers and `NewStore` returning `*Store`:
    - A mutex must not be copied after first use. Passing the store only by pointer ensures that all goroutines lock the same mutex.

## Deployment to Kubernetes

### Containerization

A multi-stage Dockerfile is used. The binary is compiled in a Go build stage, and only the binary is copied into a small Alpine image. The binary is built with `CGO_ENABLED=0`, so that no C library is required at runtime. The container is run as a non-root user.

```bash
docker build -t redis-server:local .
docker run --rm -p 127.0.0.1:6379:6379 redis-server:local
```

### Kubernetes resources

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -n redis-lab -f k8s/deployment.yaml
kubectl apply -n redis-lab -f k8s/service.yaml
kubectl rollout status deployment/redis-server -n redis-lab
```

| Resource | Purpose |
| --- | --- |
| Namespace `redis-lab` | The project is isolated from other workloads in the cluster. |
| Deployment | One pod is kept running and is replaced if it fails. |
| Service (`LoadBalancer`, port 6379) | A stable endpoint is provided, and connections are routed to the pod by label. |

The initial manifests were generated with `kubectl ... --dry-run=client -o yaml`, which proved to be a helpful way to become familiar with their structure.

### Single replica

The number of replicas was deliberately limited to one. The data is held in process memory, so each pod owns an independent store. A Service distributes connections across pods but does not synchronize data. With two replicas, a value written through one pod would not be visible through the other. The mutex solves concurrency within one process but not across pods. Scaling horizontally would therefore require a different design, such as replication or a shared external data service.

> *→ Restarting or replacing the pod results in the loss of all stored data.*

## Performance

The following command was used for the measurement:

```bash
redis-benchmark -h 127.0.0.1 -p 6379 -t set,get -n 1000000 --threads 4 -c 100
```

The workload consisted of 1,000,000 requests per command, 100 parallel clients, four benchmark threads, and a 3-byte payload.

| Metric | SET | GET |
| --- | --- | --- |
| Requests completed | 1,000,000 | 1,000,000 |
| Duration | 17.01 s | 16.51 s |
| Throughput | 58,782.04 requests/s | 60,569.35 requests/s |
| Average latency | 1.632 ms | 1.580 ms |
| Minimum latency | 0.304 ms | 0.312 ms |
| p50 latency | 1.503 ms | 1.447 ms |
| p95 latency | 2.783 ms | 2.703 ms |
| p99 latency | 3.991 ms | 3.983 ms |

For both commands, the p99 latency remained below 4 ms. The throughput of `GET` was slightly higher than that of `SET`, which is consistent with the use of a read lock.
