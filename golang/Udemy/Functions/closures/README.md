# Closures

A closure is a function (in Go: an anonymous function) that **locks in** variables and parameters from the scope in which it was created — and keeps those values available at every future execution, no matter what happens to the outer scope afterwards.

Code in [closures.go](closures.go). Run all demos with `go run .` from the [Functions folder](../) — [main.go](../main.go) calls each demo in turn.

## The factory function pattern

`createTransformer` produces functions with different configurations. Its return type is a function type, and it returns an [anonymous function](../anonymous/README.md):

```go
func createTransformer(factor int) func(int) int {
	return func(number int) int {
		return number * factor
	}
}
```

Look closely at the returned function:

- `number` is its **own** parameter.
- `factor` is **not** — it is a parameter of the *outer* `createTransformer`.

Because of scoping, an inner scope can use variables and parameters of outer scopes (parameters act like variables). So the anonymous function can use `factor`, even though it will be executed long after `createTransformer` itself has finished.

## Using the factory

```go
double := createTransformer(2) // produces a function that multiplies by 2
triple := createTransformer(3) // a different function, multiplying by 3

doubled := transformNumbers(&numbers, double)
tripled := transformNumbers(&numbers, triple)
```

Each call to `createTransformer` is its own function execution with its own scope, so `double` and `triple` are entirely independent functions.

## What "closing over" means

Calling `createTransformer(2)` locks `factor = 2` into the produced function:

- The value is available whenever `double` runs later — even though the `createTransformer` execution that created it is long gone.
- Later calls (`createTransformer(3)`, ...) run in **different scopes** and produce different functions. They can never change what `double` does.
- Every anonymous function is a closure; the term only matters when the function actually uses outer-scope values.

That combination — factory function + closure — is why [functions returning functions](../functionvalues/README.md#functions-returning-functions) is genuinely useful: you can build customized functions at runtime.

## Things to watch out for

- **The locked-in value is a snapshot of that one execution.** Changing the variable in the outer scope afterwards (in other languages; in this pattern the outer execution simply ended) does not retroactively change the closure — each `createTransformer` call made its own scope.
- **Only used outer variables are captured.** An anonymous function that touches nothing from outside is just an anonymous function, nothing more.

## Next

- [Recursion](../recursion/README.md) — functions that call themselves.
