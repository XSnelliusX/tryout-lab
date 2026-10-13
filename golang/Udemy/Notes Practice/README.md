# Notes Practice

A small command-line app that puts the struct and interface lessons into practice. It asks for a todo and a note, shows each one, and saves it to a JSON file.

Lessons 90–103, code in [main.go](main.go), [note/note.go](note/note.go) and [todo/todo.go](todo/todo.go).

## Structure

- `note/note.go` defines the `Note` struct, its constructor `New`, and its methods `Display` and `Save`.
- `todo/todo.go` defines the `Todo` struct in the same way, with `New`, `Display` and `Save`.
- `main.go` gets the user input, creates the `Todo` and `Note`, and passes them to shared helper functions. It defines the interfaces `saver` and `outputable`.

Only the exported names (`Note`, `New`, `Display`, `Save`, `Todo`) can be used from `main`. The packages are imported as `"notes.practice/note"` and `"notes.practice/todo"`.

## Struct tags for JSON

```go
type Note struct {
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}
```

The text in backticks after each field is a **struct tag**. `encoding/json` reads it to decide the key name in the JSON output. Without tags, the key would be the field name (`Title`). Tags are metadata. They do not change how the struct behaves in Go code.

Only exported fields (uppercase) are encoded. A lowercase field is silently skipped by `json.Marshal`.

## Constructor with validation

```go
func New(title, content string) (*Note, error) {
	if title == "" || content == "" {
		return &Note{}, errors.New("Input can't be empty")
	}

	return &Note{
		Title:     title,
		Content:   content,
		CreatedAt: time.Now(),
	}, nil
}
```

The constructor is the only place where a `Note` is created, so the validation always runs. `main` checks `err` before it uses the result. Returning `&Note{}` next to an error is harmless here, because `main` returns early. Returning `nil` is the more common choice and makes a missed check fail faster.

## Methods with value receivers

```go
func (note Note) Display() { ... }

func (note Note) Save() error { ... }
```

Both methods only read the struct, so a value receiver is enough. This matches the rule from the [structs README](../Structs/README.md#value-receiver-vs-pointer-receiver): use a pointer receiver only when the method needs to change fields. Passing a `Note` by value copies three small fields, which is cheap.

`main` passes a `*Note` from `note.New` to the helpers. Go calls the value-receiver methods on it by following the pointer, so this works.

## Interfaces

An interface lists the methods a type must have. Any type with those methods satisfies the interface, and no `implements` keyword is needed:

```go
type saver interface {
	Save() error
}

type outputable interface {
	saver
	Display()
}
```

- `saver` requires `Save() error`.
- `outputable` embeds `saver` and adds `Display()`. Interfaces can be combined this way, so `outputable` requires both methods.

The helpers accept the interfaces instead of concrete types:

```go
func outputData(data outputable) error {
	data.Display()
	return saveData(data)
}

func saveData(data saver) error {
	err := data.Save()
	if err != nil {
		fmt.Println("Saving the note failed!")
		return err
	}
	fmt.Println("Your note is saved!")
	return nil
}
```

Because of this, `outputData` works with both a `*todo.Todo` and a `*note.Note`. The same code handles either type, as long as it has the required methods. `saveData` only needs `Save`, so it accepts anything with that method, and `outputData` passes its `outputable` value to it, since `outputable` includes `saver`.

## Saving with `json.Marshal`

```go
func (note Note) Save() error {
	fileName := strings.ReplaceAll(note.Title, " ", "_")
	fileName = strings.ToLower(fileName) + ".json"

	json, err := json.Marshal(note)
	if err != nil {
		return err
	}

	return os.WriteFile(fileName, json, 0644)
}
```

- `json.Marshal` turns the struct into bytes, using the tags as key names.
- `os.WriteFile` writes those bytes to a file. The file name is the title in lowercase with underscores, for example `my_title.json`.
- Errors are returned to the caller, not printed inside the method.

Two notes on this code:

- The local variable `json` shadows the `encoding/json` package name after that line. It works, but a name like `data` is clearer.
- `Todo.Save` always writes to `todo.json`, so each new todo overwrites the previous one.
- A title with characters that are invalid in file names (such as `/`) will make `WriteFile` fail. That error is returned and `saveData` prints "Saving the note failed!".

## Reading input

`fmt.Scanln` reads only one word, so the code uses `bufio` to read whole lines:

```go
reader := bufio.NewReader(os.Stdin)
text, err := reader.ReadString('\n')
```

`ReadString('\n')` reads up to and including the newline. `TrimSuffix` removes the `\n`, and on Windows also the `\r`.

**Known issue:** `getUserInput` creates a new `bufio.Reader` on every call. A reader reads more data than one line from the input and keeps the extra in its buffer. When the input comes from a pipe or a file, the first reader can take both lines, and the second reader then gets nothing. Typing interactively usually works, but piped input shows the bug:

```sh
printf 'My Title\nMy content\n' | go run .
# Note content: Input can't be empty
```

The fix is to create one reader in `main` and pass it to `getUserInput`, so all calls share one buffer.

## Known issue: `go vet` warning in `todo.go`

```go
func (todo Todo) Display() {
	fmt.Printf(todo.Text)
}
```

`go vet` reports `non-constant format string in call to fmt.Printf`. The text is passed as the format string, so a `%` in a todo (for example `50%`) is printed incorrectly or produces `%!` markers. The fix is `fmt.Print(todo.Text)`, or `fmt.Printf("%v", todo.Text)`.

## Things to watch out for

- **Interfaces are satisfied implicitly.** A type matches an interface by having the methods, so a missing method is only found when you pass the value to a function that needs the interface.
- **Errors come back as values.** Check `err` after `New` and `Save`, then return or print a message.
- **Struct tags are only metadata.** They do nothing unless a package such as `encoding/json` reads them.
- **Shared input buffers.** Create one `bufio.Reader` per input source, not one per read.
- **File names come from user input.** Titles with spaces, slashes or other special characters can give unexpected file names or errors.

## Next

- Reading and decoding JSON back into a `Note` (`json.Unmarshal`).
- Adding an `ID` or a timestamp-based file name so notes don't overwrite each other.
