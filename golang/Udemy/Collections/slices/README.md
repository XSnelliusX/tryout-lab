# Slices

A slice is a flexible **view into an array**. Slices are what you use most in Go, and they are always based on an array under the hood. The basics of that array are covered in the [arrays README](../arrays/README.md).

Lessons 113–119, code in [slices.go](slices.go) (`Run`, `RunCapacity`, `RunLoop`). Practice exercises, code in [../practice/array_practice.go](../practice/array_practice.go). Run all collection demos with `go run .` from the [Collections folder](../) — [main.go](../main.go) calls each demo in turn.

## Creating a slice

A slice is written without a size, and is created from an array or another slice with `[start:end]`:

```go
featuredPrices := prices[1:]            // from index 1 to the end
highlightedPrices := featuredPrices[:1] // only the first element of featuredPrices
```

- `start` is included, `end` is excluded.
- If you leave out `start`, it starts at `0`. If you leave out `end`, it runs to the end.

A slice literal also has no size in its brackets — `[]float64{...}` creates a slice, while `[4]float64{...}` creates an array:

```go
dynamicPrices := []float64{10.99, 8.99}
```

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
fmt.Println(highlightedPrices) // [199.9 45.99 20]
fmt.Println(len(highlightedPrices), cap(highlightedPrices)) // 3 3
```

Even though `highlightedPrices` had length 1, it can grow to 3 because the elements exist in the array.

You cannot grow to the left. The first element of `prices` (`10.99`) is outside `featuredPrices`, and `highlightedPrices` only knows about the array from its own start onward. Once a slice starts after an element, that element is no longer reachable through the slice.

Rule of thumb: a slice can grow to the right up to its capacity, never to the left.

## Dynamic arrays with append

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

## Pre-allocating capacity with make

When you create an empty slice with a literal (`userNames := []string{}`), Go creates an empty array behind the scenes and has to allocate a **new, bigger array every time** `append` outgrows it.

If you roughly know how many elements you will add, reserve the space up front with the built-in `make` function:

```go
userNames := make([]string, 0, 5) // length 0, capacity 5
userNames = append(userNames, "Max", "Manuel")

fmt.Println(userNames)                      // [Max Manuel]
fmt.Println(len(userNames), cap(userNames)) // 2 5
```

- `make` takes the slice **type** (no literal braces) plus a length and, optionally, a capacity. `make([]T, length)` sets both length and capacity to the same value.
- The **capacity** controls how much memory Go allocates up front. Appending within that capacity reuses the existing array — no reallocation, no copying. Only going beyond it allocates new space.
- With length `0`, the first `append` writes to index `0`. With length `2`, the slice already contains two zero-value strings and appending fills slots *after* them — the empty slots are in front. To fill those slots directly, assign by index (`userNames[0] = "Max"`), which only works because `make` created real slots; on a slice literal with no elements it would panic.
- This is an optimization for when you can estimate the size. In many apps it doesn't matter, but it can make memory management more efficient for certain workloads.

## Looping with for range

The `for ... range` loop visits every item in a collection. For a slice, it exposes **two values per iteration**: the index of the current item and the value stored at that index. The variable names are up to you (`i`, `val`, ...):

```go
for index, value := range userNames {
	fmt.Println("Index:", index, "Value:", value)
}
```

- The syntax is the same whether the slice was created with `make` or not.
- `range` steps through the entire slice, including empty slots. A slice from `make([]string, 2, 5)` with `userNames[0] = "Julie"` prints index 0 = `Julie`, index 1 = `""`, index 2 = `Max`, index 3 = `Manuel` after two appends.
- Arrays can be ranged over in exactly the same way.
- Inside the loop body you can do anything — call functions with the value, create structs, and so on.

## Things to watch out for

- **Slices share memory.** Changing an element through one slice changes the others and the array. If you need an independent copy, make one (for example with `append` to a new slice or `copy`).
- **Capacity is not length.** `len` tells you how many elements you can read. `cap` tells you how far you can reslice to the right.
- **Indexes out of range panic.** `s[5]` on a 3-element slice crashes the program, even if the array is bigger.
- **Assigning to an empty slice literal panics.** `s := []string{}; s[0] = "x"` has no slots to write to. Use `make` when you want slots up front.

## Next

- [Maps](../maps/README.md) for key-value storage, including the map variant of the `for ... range` loop.
