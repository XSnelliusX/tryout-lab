# Generics

Generics let one function work with several types without writing a copy for each one. Before generics, Go had to use `interface{}` (or `any`) and type assertions, which is less safe and more code.

Lessons 104–108, code in [dynamic_types.go](dynamic_types.go).

## The two approaches

The file has the same `add` logic written two ways.

### Dynamic types with `any`

```go
func addDynamic(a, b interface{}) any {
	aInt, aIsInt := a.(int)
	bInt, bIsInt := b.(int)

	if aIsInt && bIsInt {
		return aInt + bInt
	}
	// ...same for float64 and string
	return nil
}
```

- `interface{}` is the same as `any`. It accepts any value.
- `a.(int)` is a **type assertion**. It returns the value as `int` and a `bool` that says whether the assertion worked. The two-value form is safe. The one-value form (`a.(int)`) panics if `a` is not an `int`.
- The function has to check every type it supports, one after another, and it returns `any`. The caller gets back an `any` and has to know what to expect.
- If the types don't match or are unsupported, it returns `nil`. The compiler can't catch this, so the mistake shows up only at runtime.

### Generics with a type parameter

```go
func addGeneric[T int | float64 | string](a, b T) T {
	return a + b
}
```

- `[T int | float64 | string]` declares a **type parameter** `T`. The part after `T` is a **constraint**: `T` may only be `int`, `float64` or `string`. The `|` means "or" (a union).
- `a, b T` means both arguments have the same type, and the return value has that type too.
- The `+` operator works because every type in the constraint supports it. A type outside the constraint is rejected at compile time.
- Go works out `T` from the arguments, so `addGeneric(1, 2)` is called without writing `[int]`.

```go
addGeneric(1, 2)             // T = int,     returns int
addGeneric(5.5, 3.2)         // T = float64, returns float64
addGeneric("Hello", "World") // T = string,  returns string
```

## Comparing the two

| | `addDynamic` (`any`) | `addGeneric` (`T`) |
| --- | --- | --- |
| Type checked at | runtime | compile time |
| Return type | `any`, needs a type assertion to use | `T`, the same as the input |
| Unsupported types | return `nil`, no error | compile error |
| Code size | one branch per type | one function for all types |

`main` shows both working with the same results: `3`, `8.7` and `HelloWorld`.

Because `addGeneric` returns `T`, the result has a real type and you can use it directly. The `any` version gives you a value you have to convert back before you can do much with it.

## Things to watch out for

- **Constraints restrict what you can do.** `T int | float64 | string` allows `+`, but not `-`, because `string` has no subtraction.
- **`any` is the same as "no check".** It accepts everything, so the compiler can't help. Prefer a type parameter when you know which types are allowed.
- **Unhandled types in `addDynamic` return `nil`.** Calling `addDynamic(1, "a")` gives `nil` and no error, which is easy to miss.
- **One-value type assertions panic.** Use `v, ok := x.(T)` unless you are sure of the type.

## Next

- Generic types, such as a generic struct (`type Stack[T any] struct`).
- Constraints that describe a set of methods, combined with interfaces.
