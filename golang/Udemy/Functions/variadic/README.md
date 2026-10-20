# Variadic functions

A **variadic function** accepts any number of arguments for one parameter, written with three dots: `numbers ...int`. "The amount of parameters is variable" — that is the whole idea, and thankfully the syntax is straightforward.

Code in [variadic.go](variadic.go). Run all demos with `go run .` from the [Functions folder](../) — [main.go](../main.go) calls each demo in turn.

## Defining one

A sum function that takes any amount of numbers — without forcing callers to build a slice first:

```go
func sumUp(numbers ...int) int {
	sum := 0
	for _, val := range numbers {
		sum += val
	}
	return sum
}
```

At the call site, values are passed one by one — as many as you like:

```go
sumUp(1, 2, 3, 4, 5) // all ints, any count
```

Inside the function, `numbers` is simply a `[]int`: the three dots **collect** the standalone arguments and merge them into a slice. That is why the body loops over it with `range` as usual. Any value type works (`...string`, `...User`, ...), as long as every collected argument matches it.

## Mixing with regular parameters

Variadic parameters can combine with normal ones. The regular parameter is filled first, everything after it is collected:

```go
func sumUpWithStart(startingValue int, numbers ...int) int {
	sum := startingValue
	for _, val := range numbers {
		sum += val
	}
	return sum
}

sumUpWithStart(10, 1, 2, 3) // 10 -> startingValue, 1 2 3 -> the slice
```

Useful when some inputs deserve their own named parameter and the rest is a "collect all the rest" list.

## The opposite direction: spreading a slice

The three dots have a second meaning at the **call site**. If you *have* a slice but call a variadic function, spread the slice into standalone arguments:

```go
numbers := []int{1, 10, 15}
anotherSum := sumUp(numbers...)
```

Behind the scenes this calls `sumUp(1, 10, 15)` — the elements are pulled out of the slice and passed as individual arguments. You met this operator already with [append and slices](../../Collections/slices/README.md#dynamic-arrays-with-append) (`append(all, discountPrices...)`); it works for any variadic function.

## Things to watch out for

- **The variadic parameter must be the last one** — everything after it could not be told apart from the collected values, so Go forbids it.
- **Inside the function it is just a slice** — `len(numbers)`, `range`, indexing all work; there is nothing special left.
- **`numbers` alone is not a slice at the call site.** Passing an existing slice requires `numbers...`, not `numbers`.

## Section complete

That covers the advanced functions section: [functions as values](../functionvalues/README.md), [anonymous functions](../anonymous/README.md), [closures](../closures/README.md), [recursion](../recursion/README.md) and variadic functions.
