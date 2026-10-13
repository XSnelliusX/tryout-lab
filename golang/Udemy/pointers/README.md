# Pointers

A pointer holds the **memory address** of a value instead of the value itself. Pointers let a function work on the original value rather than a copy of it.

Lessons 63–71, code in [pointers.go](pointers.go). For pointers to structs and methods, see the [structs README](../Structs/README.md).

## Basics

| Syntax | Meaning |
| --- | --- |
| `&x` | address of `x` (the "address-of" operator) |
| `*T` | type "pointer to `T`", e.g. `*int` |
| `*p` | the value `p` points to (dereferencing) |

```go
age := 32
agePointer := &age     // agePointer has type *int
fmt.Println(*agePointer) // 32, read the value through the pointer
*agePointer = 40         // write through the pointer
fmt.Println(age)         // 40, the same variable changed
```

A pointer that points to nothing is `nil`. Dereferencing a `nil` pointer crashes the program (`panic: invalid memory address or nil pointer dereference`), so check before you use it:

```go
var p *int
if p != nil {
	fmt.Println(*p)
}
```

## Why pointers?

Go passes everything **by value**. Passing a variable to a function gives the function its own copy.

```go
func addOne(n int) {
	n++ // changes only the copy
}

x := 1
addOne(x)
fmt.Println(x) // still 1
```

Passing a pointer gives the function the address of the original value:

```go
func addOne(n *int) {
	*n++ // changes the original
}

x := 1
addOne(&x)
fmt.Println(x) // 2
```

The lectures summarize the two reasons to use pointers:

1. **Avoid unnecessary copies.** Copying a small `int` is cheap. A very large or complex value is expensive to copy on every call. With a pointer, only one copy of the value exists in memory and just its address is passed around.
2. **Directly mutate values.** The function edits the underlying value, so it does not need to return anything. This can mean less code, but it can also make code harder to follow, because a call can change a variable without any visible assignment at the call site.

Rule of thumb: use a pointer when a function needs to change the caller's value or when the value is large. Otherwise pass the value.

## Pointers and `fmt.Scan`

`fmt.Scan` reads user input and stores it in variables. It needs pointers to do that:

```go
var name string
fmt.Print("Enter your name: ")
fmt.Scan(&name)
fmt.Println("Hello", name)
```

`fmt.Scan` is a function that receives a *pointer* to `name`, not a copy of it. It uses that pointer to overwrite the variable with whatever the user typed. If you passed `name` directly (`fmt.Scan(name)`), `Scan` would only change its own copy, and `name` would stay empty. The `&` is what connects the variable to the input.

The same idea works for any type. `fmt.Scan` accepts pointers to `int`, `float64`, `string` and so on, and it parses the input into the type the pointer points to.

## Pointers in function parameters

The `editAgeToAdultYears` example in `pointers.go` shows the pattern:

```go
func editAgeToAdultYears(age *int) {
	*age -= 18
}
```

- The parameter type is `*int`, so the function receives an address.
- `*age -= 18` changes the value stored at that address.
- `main` passes `agePointer`, so `age` in `main` is updated and no return value is needed.

## Pointers to structs

Structs are the most common place to use pointers in Go. The constructor in the [structs README](../Structs/README.md) returns a pointer so the struct is created once and not copied:

```go
func New(firstName, lastName, birthdate string) (*User, error) {
	return &User{...}, nil
}
```

Go also lets you read fields through a struct pointer without writing `(*u).firstName`. `u.firstName` works on both `User` and `*User`.

Pointer receivers on methods use the same idea. `func (u *User) ClearUserName()` receives the address of the struct, so it can change the original. A value receiver `func (u User) ...` gets a copy. See [Value receiver vs pointer receiver](../Structs/README.md#value-receiver-vs-pointer-receiver).

## Things to watch out for

- **Hidden changes.** When a function takes a pointer, the caller's variable may change. Name functions and parameters so this is clear, e.g. `editAge` rather than `process`.
- **`nil` pointers.** A pointer that was never set is `nil`. Dereferencing it panics. Constructors that return `nil` on error (like `user.New`) need the error checked before use.
- **Copies still happen with plain values.** Only the pointer is copied, not the value it points to. That is why pointers help with large values.
- **Value methods on a struct do not edit it.** If a method must change fields, give it a pointer receiver. See the [structs README](../Structs/README.md).

## Next

- Structs with embedded types and interfaces, see the [structs README](../Structs/README.md).
