# Arrays

An array has a **fixed size**. The size is part of the type: `[4]float64` and `[5]float64` are different types. Arrays are the foundation that slices are built on — see the [slices README](slices/README.md).

Code in [arrays.go](arrays.go). Run all collection demos with `go run .` from the [Collections folder](../Collections/) — [main.go](../main.go) calls each demo in turn.

## Creating an array

```go
prices := [4]float64{10.99, 9.99, 45.99, 20.0}
```

- The size goes in the brackets. It is fixed for the lifetime of the array.
- Elements you don't set get the **zero value** (`""` for strings, `0` for numbers).

```go
var productNames [4]string = [4]string{"A book"}
productNames[2] = "carpet"
fmt.Println(productNames) // [A book  carpet ]
```

The empty elements print as blanks, because `""` prints as nothing.

## Reading and writing elements

Read or write an element by its index. Indexes start at `0`:

```go
fmt.Println(prices[2]) // 45.99
productNames[2] = "carpet" // assign by index
```

`len` also works on arrays and returns the fixed size:

```go
fmt.Println(len(prices)) // 4
```

## Things to watch out for

- **The size is part of the type.** You cannot append to an array or change its size.
- **Out-of-range indexes panic.** `prices[4]` on a 4-element array crashes the program — valid indexes are `0` to `3`.
- **Arrays are rarely used directly.** When the number of items can change, use a [slice](slices/README.md) instead.

## Next

- [Slices](slices/README.md), the flexible window into an array.
