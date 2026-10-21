# Concurrency

Goroutines, channels, `select` and `defer`: running functions concurrently instead of strictly one after another, and coordinating them so the program waits for the work to finish. Concurrency lets tasks make progress independently; parallelism means executing at the same time, which depends on the runtime and available CPU cores.

Code is split into one package per topic, all called from [main.go](main.go). Goroutines build on the function calls covered in the [Functions notes](../Functions/README.md).

| Package | Idea | Code |
| --- | --- | --- |
| `greet/` | goroutines, one channel shared by several goroutines, `for range` and `close` | [greet/greet.go](greet/greet.go) |
| `filemanager/` | reading and writing files, `defer file.Close()` | [filemanager/filemanager.go](filemanager/filemanager.go) |
| `report/` | one goroutine per region, a done and an error channel each, `select` | [report/report.go](report/report.go) |

Run with `go run .` from this folder. Each report run writes `report_<region>.txt` next to `main.go`. These generated files are ignored by Git. The writes are slow on purpose (3 seconds each), so the whole run takes about 9 seconds: 3 for the greet demo and 3 for each report run. Within one report run, the regional jobs run concurrently. The second run intentionally reports a negative amount and overwrites reports for its valid regions; it does not remove the earlier report for the invalid region.

## How Go executes without concurrency

Normal function calls run **sequentially**: the second function only starts after the first one finished, line by line, top to bottom.

- If one function takes long, it **blocks** all subsequent function calls until it's done.
- That's often fine. Many functions are quick or depend on each other, and running those in parallel wouldn't make sense.
- A long-running task might be a slow calculation, a file operation, or a network request. In [filemanager.go](filemanager/filemanager.go), `time.Sleep(3 * time.Second)` simulates a slow disk.

Goroutines are useful when a slow operation blocks code that **does not depend on it**. If the next call needs the previous call's result, it must wait for that result.

## Goroutines

The built-in `go` keyword in front of a function call runs it as a **goroutine**:

```go
go greet("Nice to meet you!", done)
go slowGreet("How ... are ... you ...?", done)
```

- The function runs **concurrently** with the code that started it, possibly in parallel.
- The function may return values, but a `go` call **discards them**, and the caller doesn't wait for it. Execution continues immediately.

Without any waiting, `main` may exit before the goroutines run, so some or all output can be missing. Once `main` returns, the program exits, even if goroutines are still running.

## Channels

A channel lets goroutines **communicate and synchronize**. It can carry data between goroutines, including completion signals back to the caller.

```go
done := make(chan bool) // make + chan + the type of data sent through it
```

The arrow `<-` always points in the direction the data flows:

```go
doneChan <- true // send: the value on the right goes into the channel on the left
<-done           // receive: wait until a value comes out of the channel
```

- The channel is passed to the goroutine as a normal argument, and the goroutine sends on it when it's done.
- `<-done` pauses until a value arrives. The value can be printed, or discarded when only the signal matters.

## One channel, many goroutines

One channel can be shared by **multiple goroutines**. It is meant to carry multiple values.

A single `<-done` only waits for **one** value, so the first signal ends the wait, not necessarily all the work. This is a synchronization bug, not necessarily a data race. To wait for all of them, use one of these:

1. Read once per goroutine. This works, but you must update the count whenever you add a goroutine.
2. Give each goroutine its own channel, stored in a slice (channels are normal values, so they can go in slices, maps and structs), and wait on each one:

   ```go
   doneChans := make([]chan bool, 4)
   for i := range doneChans {
       doneChans[i] = make(chan bool)
       go job(doneChans[i])
   }
   for _, doneChan := range doneChans {
       <-doneChan
   }
   ```

The shared-channel demo below counts completion signals and closes the channel after all four arrive.

## for range over a channel and close

`for ... range` works **directly on a channel**, with one iteration per value sent:

```go
for range done {
}
```

An empty body is fine if another goroutine closes the channel after all sends. In [greet.go](greet/greet.go), four goroutines share `done`, and the receiving loop counts their signals so it knows when to close it.

- **Problem:** Go can't tell that no more values are coming. After the last value the loop waits forever. If all goroutines are blocked, Go reports `fatal error: all goroutines are asleep - deadlock!`.
- **Fix:** call the built-in `close` once no more values will be sent. The loop then ends.

```go
completed := 0
for range done {
	completed++
	if completed == 4 {
		close(done) // every worker has sent its one completion signal
	}
}
```

A closed channel accepts no more sends, but buffered values can still be received before `for range` ends. Sending after the close panics with `send on closed channel`. Here the receiver can safely close because it has received exactly one signal from every worker. **A sleep does not guarantee which worker finishes last.** If you add a worker, update the expected count too. Channels do not need closing unless a receiver needs that end-of-stream signal.

## Getting errors from goroutines

A `go` call discards return values, so returning an `error` from `Process` would not deliver it to the caller. Pass a channel instead:

```go
func (job regionJob) Process(doneChan chan bool, errChan chan error) {
	for _, amount := range job.amounts {
		if amount < 0 {
			errChan <- fmt.Errorf("region %s has a negative amount: %.2f", job.region, amount)
			return
		}
	}
	// ... write the report ...
	doneChan <- true
}
```

- A plain `return` still stops the function early. It just has no value for the caller to receive.
- Each goroutine gets its own `doneChan` and `errChan`. The caller passes them in, then waits on them.

## Buffered channels

`make(chan error, 1)` creates a channel with room for one value. A send into a buffered channel doesn't block while there is space.

```go
doneChans[i] = make(chan bool, 1)
errChans[i] = make(chan error, 1)
```

The unbuffered version (`make(chan error)`) blocks on the send until someone receives. A buffer of 1 lets each goroutine send its single result and exit even if the caller has not reached that region yet. Buffering does not wait for workers: `report.Run` still receives one outcome per region before returning, including when a job fails.

## select

`select` waits on several channel operations at once and runs **one ready case**. The other operations are not performed by that `select`; the channels remain usable afterward.

```go
var firstErr error
for i, job := range jobs {
	select {
	case err := <-errChans[i]:
		if firstErr == nil {
			firstErr = err
		}
	case <-doneChans[i]:
		fmt.Println("Report written for", job.region)
	}
}
return firstErr
```

- Each goroutine sends either an error or `true`, never both, so exactly one case fires.
- `select` without a `default` blocks until a case is ready. If no goroutine ever sends on either channel, the program hangs.
- If several cases are ready at once, Go picks one at random.
- This loop goes in index order. An error from region 3 is only seen after regions 0 to 2 have been reported. Regions that finish earlier wait in their buffers.
- Keep the first error, but continue receiving until every region has finished. Returning immediately could leave files partially written when `main` exits or the next report run starts.

## defer

`defer` postpones a call until the surrounding function returns, whether it returns normally or early because of an error. Use it for cleanup that must always run:

```go
func ReadLines(path string) ([]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close() // runs when ReadLines returns, on every return path

	// ... scan the file ...
}
```

- Put the `defer` right after the error check, so it only runs when the file was opened.
- Without `defer`, `file.Close()` has to be repeated before every `return`, and it's easy to miss one.
- Deferred calls run in reverse order when several are stacked.

## Things to watch out for

- **Goroutines don't keep the program alive.** When `main` returns, unfinished goroutines are cut off. Wait for all necessary work, even when one worker reports an error.
- **One read = one value.** A channel shared by four goroutines needs four reads (or a `for range` loop with `close`) to wait for all of them.
- **Ranging over a channel without `close` blocks** once all available values are received; it deadlocks if no goroutine can make progress.
- **Sending on a closed channel panics.** Close only after the last send.
- **Output order depends on synchronization.** Greetings can appear in any order; report-success messages follow the regions' first appearance in the input because the receiver visits jobs by index.
- **`select` with nothing ready blocks.** Make sure every path sends on one of the channels you listen to.
