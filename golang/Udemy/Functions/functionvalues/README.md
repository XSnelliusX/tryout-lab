# Functions as values

Functions are **first class values** in Go: like an `int` or a slice, a function can be stored, passed around, given to other functions as a parameter value — and returned from other functions.

Code in [functionvalues.go](functionvalues.go). Run all demos with `go run .` from the [Functions folder](../) — [main.go](../main.go) calls each demo in turn.

## The starting point: two utility functions

Doubling every number in a slice needs a loop. To avoid rewriting that loop for every transformation, outsource it into a function — and the single-number operation into its own helper:

```go
func transformNumbers(numbers *[]int, transform transformFn) []int {
	dNumbers := []int{}

	for _, val := range *numbers {
		dNumbers = append(dNumbers, transform(val))
	}

	return dNumbers
}

func doubleNumbers(number int) int {
	return number * 2
}
```

Without functions-as-values, tripling would need a whole second copy of `transformNumbers` with `tripleNumbers` hard-coded inside. That duplication is what this feature removes.

## Function types

In a place where a **type** is expected, `func` defines a function *type*: the parameter types and return types of the function, no body:

```go
func transformNumbers(numbers *[]int, transform func(int) int) []int
```

This declares the `transform` parameter as "a function that takes one `int` and returns one `int`". The type can be any shape you need — multiple parameters, multiple return values:

```go
func(int, []string, map[string][]int) ([]int, string)
```

## Passing a function as a value

Because `transform` is a function, it can be executed inside `transformNumbers`. And at the call site, the function itself is passed — **by name, without parentheses**:

```go
doubled := transformNumbers(&numbers, doubleNumbers) // no () — the function itself, not its result
tripled := transformNumbers(&numbers, tripleNumbers) // same generic function, different behavior
```

- `doubleNumbers` executes the function and passes its *return value* — that is not what we want here.
- `doubleNumbers` (no parentheses) passes the *function itself*, exactly like using a variable by its name.
- One generic `transformNumbers` now serves every transformation: no code duplication.

## Custom types for function types

Function types can get long, so store them in a custom type (same idea as the `floatMap` alias in the [maps README](../../Collections/maps/README.md#type-aliases-for-long-map-types)):

```go
type transformFn func(int) int

func transformNumbers(numbers *[]int, transform transformFn) []int
```

Purely a convenience — less typing, fewer errors — and it reads nicely in return types too.

## Functions returning functions

The return type of a function can be a function type as well:

```go
func getTransformerFunction(numbers *[]int) transformFn {
	if (*numbers)[0] == 1 {
		return doubleNumbers
	} else {
		return tripleNumbers
	}
}
```

Calling it yields a *function*, which can then be used like any other function value:

```go
transformFn1 := getTransformerFunction(&numbers)             // a function, chosen by logic
transformed := transformNumbers(&numbers, transformFn1)      // execute it elsewhere
```

Again: `return doubleNumbers` (no parentheses) returns the function, not a result. A made-up example, but the pattern — picking or building a function at runtime — becomes genuinely useful with [closures](../closures/README.md).

## Things to watch out for

- **No parentheses when passing or returning a function.** With them you pass the *result* instead of the function.
- **The function type must match.** A parameter declared `func(int) int` only accepts functions with exactly that shape.
- **Use named functions for reused logic**, function values for flexible/generic code.

## Next

- [Anonymous functions](../anonymous/README.md) — defining a function just in time, in the place where it is needed.
