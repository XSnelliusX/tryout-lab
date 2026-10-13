# Structs

A struct is a custom type that groups related fields (data) and methods (functions attached to the type) into one value. It is Go's way of modelling things like a user, an admin or an order.

Lessons 73–89, code in [structs.go](structs.go) and [user/user.go](user/user.go). A practice app built on structs and interfaces (lessons 90–103) is in [Notes Practice](../Notes%20Practice/README.md).

Structs and pointers work together closely. Whether a struct should be passed as a value or a pointer is covered in the [pointers README](../pointers/README.md).

## Defining a struct

```go
type User struct {
	firstName string
	lastName  string
	birthdate string
	createdAt time.Time
}
```

`type User struct { ... }` declares a new type called `User`. Each line inside is a field with a name and a type.

## Creating instances

Struct literals create an instance by naming the fields:

```go
u := User{
	firstName: "Max",
	lastName:  "Mustermann",
	birthdate: "01/01/2000",
	createdAt: time.Now(),
}
fmt.Println(u.firstName) // access a field with a dot
```

Fields you leave out get their **zero value** (`""` for strings, `0` for numbers, `nil` for pointers).

## Constructor functions

Go has no constructors. By convention, a function named `New...` creates and sets up an instance. This keeps setup in one place and lets you add validation:

```go
func New(firstName, lastName, birthdate string) (*User, error) {
	if firstName == "" || lastName == "" || birthdate == "" {
		return nil, errors.New("Inputs can not be empty")
	}

	return &User{
		firstName: firstName,
		lastName:  lastName,
		birthdate: birthdate,
		createdAt: time.Now(),
	}, nil
}
```

- The function returns an `error` as well, so the caller can react to invalid input. This is the usual Go pattern.
- `&User{...}` returns a pointer. The struct is created once and only its address is returned, so nothing is copied.
- Returning `nil, err` on failure means the caller must check `err` before using the result.

## Packages and exported names

A struct can live in its own package. In this project, `user/user.go` is `package user`, and `structs.go` imports it as `"struct/user"`.

Go controls visibility with the **first letter** of a name:

| Name | Visible outside its package? |
| --- | --- |
| `User`, `New`, `OutputUserDetails` | yes (uppercase, exported) |
| `firstName`, `createdAt` | no (lowercase, unexported) |

That is why `main` can call `user.New(...)` and `OutputUserDetails()`, but cannot read `appUser.firstName` directly. Other packages have to go through the exported functions.

## Methods

A method is a function with a **receiver** argument, which is the struct it belongs to:

```go
func (u User) OutputUserDetails() {
	fmt.Println(u.firstName, u.lastName, u.birthdate)
}

func (u *User) ClearUserName() {
	u.firstName = ""
	u.lastName = ""
}
```

Calling it looks like `appUser.OutputUserDetails()`.

### Value receiver vs pointer receiver

| Receiver | Can it change the struct? | Typical use |
| --- | --- | --- |
| `(u User)` | no, it works on a copy | reading or printing data |
| `(u *User)` | yes, it works on the original | changing data |

The lecture's key point: **if a method has to edit the struct, its receiver must be a pointer.** With a value receiver, the method edits a copy and the change is lost:

```go
func (u User) ClearUserNameWrong() {
	u.firstName = "" // changes only the copy
}
```

Calling `ClearUserName()` on `*User` changes the original. Go lets you call pointer methods on a value variable too (`u.ClearUserName()` works even if `u` is a `User`), because it takes the address for you.

## Embedding a struct

A struct can embed another struct to reuse its fields and methods:

```go
type Admin struct {
	email    string
	password string
	User
}
```

- `Admin` has all fields of `User` (`firstName`, `lastName`, ...) and all its methods, without copying the code.
- `admin.OutputUserDetails()` works directly, because the method is promoted from the embedded `User`.
- You can still add extra fields and methods to `Admin`.

`NewAdmin` in `user/user.go` returns an `Admin` value, not a pointer:

```go
func NewAdmin(email, password string) Admin {
	return Admin{ ... }
}
```

Returning a value copies the struct. For small structs this is fine and can be as fast as passing pointers. For large or complex structs, return a pointer (`*Admin`) to avoid copies.

## Struct tags

A field can have a tag in backticks. Packages like `encoding/json` read it:

```go
type Note struct {
	Title string `json:"title"`
}
```

`json.Marshal` uses the tag as the key name (`{"title": ...}`) instead of the field name. Tags only give metadata. They do not change how the struct works in Go code. Only exported fields are encoded to JSON. See [Notes Practice](../Notes%20Practice/README.md) for a full example.

## Type aliases and methods on custom types

The `type` keyword can also create a new name for an existing type, not just a struct:

```go
type str string
```

`str` is a new type with the same underlying kind as `string`. A plain alias like this rarely helps by itself, and `string` is clearer. Its real use is that you can attach methods to it:

```go
func (s str) log() {
	fmt.Println(s)
}

var name str = "Max"
name.log()
```

You cannot add methods to the built-in `string` directly (`cannot define new methods on non-local type string`). Defining your own type from it gets around this.

Note that `name := "Max"` would infer `string`, not `str`. To get your type you must declare it explicitly with `var name str = ...`.

The same works for other built-in types such as `int` or `float64`. Aliases become more useful later with slices, maps and functions.

## Things to watch out for

- **Value receivers do not change the original.** Use a pointer receiver for any method that edits fields.
- **Unexported fields are hidden from other packages.** Use exported constructor and methods (`New`, `OutputUserDetails`) instead.
- **Returning a value copies it.** Fine for small structs; use pointers for large ones.
- **Constructors can return `nil`.** Check the error before using the pointer, or you get a nil pointer panic.

## Next

- Using structs with slices and maps.
- Interfaces, which describe what methods a type must have. See the [Notes Practice README](../Notes%20Practice/README.md).
