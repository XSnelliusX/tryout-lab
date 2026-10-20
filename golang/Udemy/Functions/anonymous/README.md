# Anonymous functions

An anonymous function is a function **without a name**, written just in time — directly in the place where a function value is needed.

Code in [anonymous.go](anonymous.go). Run all demos with `go run .` from the [Functions folder](../) — [main.go](../main.go) calls each demo in turn.

## The problem they solve

Anywhere a function value is expected — a parameter of type `func(int) int`, a return value — you previously had to define a named function in advance (`double`, `triple`, ...), even if you needed it exactly once. Anonymous functions let you write the function **in place** instead.

## Writing one

Take the [functions-as-values](../functionvalues/README.md) example and replace the named function with an inline definition:

```go
doubled := transformNumbers(&numbers, func(number int) int {
	return number * 2
})
```

Anatomy:

- `func` starts it — **no name follows**, directly the parentheses.
- Then parameters (`number int`), return type (`int`) and body, like any function.
- It sits in a place where a **value** is expected (an argument for `transformNumbers`), which is what makes it a function value and not a type.

The type must still match what the receiving parameter declares. Adding a second parameter to the anonymous function would be a valid function but would not compile, because `transform func(int) int` expects exactly one `int` in and one `int` out.

## When to use them

| Situation | Better choice |
| --- | --- |
| One-off logic, needed only here | anonymous function — no extra definition, and readers see the logic right at the call site |
| Same logic used in several places | named function — otherwise you copy-paste the body everywhere |

It is a trade-off, not a rule. Anonymous functions can take any parameters and return any values, like named functions.

## Related: closures

Every anonymous function is also a **closure** — it can lock in variables from the scope around it. That deserves its own explanation: see the [closures README](../closures/README.md).

## Next

- [Closures](../closures/README.md) — factory functions that produce configured functions and lock in values.
