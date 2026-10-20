# Maps

A map stores **key-value pairs**: given a key, it returns the matching value in roughly constant time. It is Go's built-in hash map, created with `map[KeyType]ValueType`.

Code in [maps.go](maps.go). Run all collection demos with `go run .` from the [Collections folder](../) — [main.go](../main.go) calls each demo in turn.

## Creating a map

A map literal maps keys to values:

```go
websites := map[string]string{
	"example.com":         "https://example.com",
	"Google":              "https://google.com",
	"Amazon Web Services": "https://aws.com",
}
```

- `map[string]string` is a map with `string` keys and `string` values. The key and value types can be anything (`map[string]float64`, `map[int][]string`, ...).
- Like slices, maps are reference types backed by runtime data structures — copying a map variable does not copy the contents.
- A map literal without entries (`map[string]string{}`) is a valid, empty map. An uninitialized `var m map[string]string` is `nil`, and writing to a `nil` map panics.

## Reading values

Look up a value by its key:

```go
fmt.Println(websites["Google"]) // https://google.com
```

A missing key returns the **zero value** of the value type (`""` for strings, `0` for numbers) — it does not crash. To tell "missing" from "present but zero", use the two-value form:

```go
url, ok := websites["Google"]
if !ok {
	// key not in the map
}
```

## Adding and updating entries

Assigning to a key adds it if new, overwrites if existing:

```go
websites["LinkedIn"] = "https://linkedin.com"
```

## Deleting entries

The built-in `delete` removes a key-value pair. Deleting a missing key is a no-op:

```go
delete(websites, "Google")
```

## Pre-allocating memory with make

The `make` function works for maps as well as for [slices](../slices/README.md#pre-allocating-capacity-with-make). When you create an empty map with a literal, Go has to **reallocate memory whenever new items are added**. If you roughly know how many entries you will add, reserve the space up front:

```go
courseRatings := make(map[string]float64, 3)
courseRatings["Go"] = 4.7
courseRatings["React"] = 4.8
courseRatings["Angular"] = 4.5
```

- As with slices, drop the literal braces — `make` takes the map **type**, not a literal.
- Unlike `make` for slices, only **one** extra argument is allowed. Maps have no empty slots to fill, so there is no length to set — the argument is the size to pre-allocate memory for.
- `make(map[string]float64)` without the extra argument also works, but gives the same result as the literal notation: an empty map with no pre-allocated memory.
- Adding entries within that size needs no reallocation. Only going beyond it makes Go allocate new memory, so set the size to roughly the number of entries you plan to add.

## Type aliases for long map types

`map[string]float64` is quite some text to write. A **type alias** gives the type a short name — and lets you attach methods to it:

```go
type floatMap map[string]float64

func (m floatMap) Output() {
	for key, value := range m {
		fmt.Println(key, value)
	}
}
```

- `type floatMap map[string]float64` defines `floatMap` as a custom type based on the built-in map type. `make` accepts it, because Go knows it is that map behind the scenes:

```go
courseRatings := make(floatMap, 3)
courseRatings.Output() // call the custom method
```

- The main advantage is the custom methods — `courseRatings.Output()` instead of a print in the calling code.
- Even without methods, an alias saves characters everywhere the long type would otherwise appear.
- This is a developer-experience optimization, not a performance one. Using the explicit built-in type is equally fine.

## Looping with for range

The `for ... range` loop works the same for maps as it does for [slices](../slices/README.md#looping-with-for-range) — only the terms change. The first variable is the **key** rather than an index, the second the value:

```go
for key, value := range courseRatings {
	fmt.Println(key, value)
}
```

- The two variable names are up to you, but `key` fits a map better than `index`.
- Map iteration order is random, so the pairs can come out in any order.
- Whenever some operation should run for every item in a map, this loop is the tool.

## Things to watch out for

- **Key order is random.** Printing or ranging over a map returns the pairs in an unpredictable order. If you need order, keep a separate slice of keys.
- **Missing keys return the zero value.** `websites["nope"]` is `""`, not an error. Use `v, ok := m[key]` when you need to know whether the key exists.
- **Writing to a `nil` map panics.** Create it with a literal or `make(map[string]string)` before assigning.
- **Keys must be comparable.** `string`, `int`, `float64` and pointers work; slices and maps cannot be keys (structs can, if all their fields are comparable).

## Next

- Looping over slices with `for ... range`, see the [slices README](../slices/README.md#looping-with-for-range).
- Structs grouping related values, see the [structs README](../../Structs/README.md).
