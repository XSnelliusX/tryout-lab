# Arrays and Slices

An array has a fixed size. A slice is a flexible view into an array. Slices are what you use most in Go, and they are always based on an array under the hood.

Lessons for slices, code in [lists.go](lists.go). Practice exercises, code in [practice/array_practice.go](practice/array_practice.go).

## Arrays

```go
prices := [4]float64{10.99, 9.99, 45.99, 20.0}
```

- The size is part of the type. `[4]float64` and `[5]float64` are different types.
- Elements you don't set get the zero value (`""` for strings, `0` for numbers).

```go
var productNames [4]string = [4]string{"A book"}
productNames[2] = "carpet"
fmt.Println(productNames) // [A book  carpet ]
```

The empty elements print as blanks, because `""` prints as nothing.

Read or write an element by its index. Indexes start at `0`:

```go
fmt.Println(prices[2]) // 45.99
```

## Slices

A slice is written without a size, and is created from an array or another slice with `[start:end]`:

```go
featuredPrices := prices[1:]  // from index 1 to the end
highlightedPrices := featuredPrices[:1] // only the first element of featuredPrices
```

- `start` is included, `end` is excluded.
- If you leave out `start`, it starts at `0`. If you leave out `end`, it runs to the end.

## A slice is a window, not a copy

A slice does not copy the array. It points into the same memory, so changing a slice element changes the array:

```go
featuredPrices := prices[1:]
featuredPrices[0] = 199.90
fmt.Println(prices) // [10.99 199.9 45.99 20]
```

`prices[1]` changed, because `featuredPrices[0]` is the same element. Creating a slice is cheap, since only a small reference is made. Only one array exists in memory.

This is different from a pointer. A slice carries its own start, length and capacity, and you do not write `*` or `&` to use it.

## Length and capacity

Every slice has two values:

| Function | Meaning |
| --- | --- |
| `len(s)` | number of elements in the slice |
| `cap(s)` | how many elements the slice can reach to the right, counting from its start |

The built-in functions `len` and `cap` need no import. `len` also works on arrays and strings.

```go
highlightedPrices := featuredPrices[:1]
fmt.Println(len(highlightedPrices), cap(highlightedPrices)) // 1 3
```

- `len` is 1, because the slice holds one element.
- `cap` is 3, because the slice's underlying array still has two more elements to the right of it (`45.99` and `20`).

## Reslicing grows to the right only

A slice can grow up to its capacity by reslicing to a larger end index:

```go
highlightedPrices = highlightedPrices[:3]
fmt.Println(highlightedPrices)       // [199.9 45.99 20]
fmt.Println(len(highlightedPrices), cap(highlightedPrices)) // 3 3
```

Even though `highlightedPrices` had length 1, it can grow to 3 because the elements exist in the array.

You cannot grow to the left. The first element of `prices` (`10.99`) is outside `featuredPrices`, and `highlightedPrices` only knows about the array from its own start onward. Once a slice starts after an element, that element is no longer reachable through the slice.

Rule of thumb: a slice can grow to the right up to its capacity, never to the left.

## Dynamic arrays with slices

A slice literal has no size in its brackets, so it is not fixed like an array:

```go
dynamicPrices := []float64{10.99, 8.99}
fmt.Println(dynamicPrices[0]) // 10.99
dynamicPrices[1] = 9.99
fmt.Println(dynamicPrices[0]) // 10.99
```

- `[]float64{...}` creates a slice, while `[4]float64{...}` creates an array.
- Indexes work the same way for both. You can change an element with `dynamicPrices[1] = 9.99`.

To add elements, use `append`. It returns a new slice, so keep the result in a variable:

```go
updatedPrices := append(dynamicPrices, 0.99, 12.0)
fmt.Println(updatedPrices, dynamicPrices) // [10.99 9.99 0.99 12] [10.99 9.99]
```

- `dynamicPrices` has no spare capacity, so `append` allocates a new array and copies the elements into it. The original slice is not changed.
- If a slice has spare capacity, `append` writes into the existing array instead. In that case the original slice and the new slice share memory, so the change is visible through both.
- Always assign the result of `append` back (`s = append(s, x)`). Ignoring it means the new elements are lost.

To join two slices, unpack the second one with `...`:

```go
discountPrices := []float64{10.42, 39.12, 0.12, 3.92}
allPrices := append(updatedPrices, discountPrices...)
fmt.Println(allPrices) // [10.99 9.99 0.99 12 10.42 39.12 0.12 3.92]
```

- Without `...`, `append` would add the whole slice as a single element, which does not compile for a `[]float64` target.
- `...` works for any slice you pass to a variadic function.

## Things to watch out for

- **Slices share memory.** Changing an element through one slice changes the others and the array. If you need an independent copy, make one (for example with `append` to a new slice or `copy`).
- **Capacity is not length.** `len` tells you how many elements you can read. `cap` tells you how far you can reslice to the right.
- **Indexes out of range panic.** `s[5]` on a 3-element slice crashes the program, even if the array is bigger.
- **Arrays have a fixed size.** Use slices when the number of items changes.

## Next

- `make` to create a slice with a given length and capacity.
