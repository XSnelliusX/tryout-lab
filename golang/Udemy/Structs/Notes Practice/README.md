# Notes Practice

A small command-line note app that puts the struct lessons into practice. It asks for a title and content, creates a `Note`, shows it, and saves it to a JSON file.

Lessons 90–97, code in [main.go](main.go) and [note/note.go](note/note.go).

## Structure

- `note/note.go` is a package that defines the `Note` struct, its constructor `New`, and its methods `DisplayNote` and `Save`.
- `main.go` gets the user input, calls the package, and handles errors.

Only the exported names (`Note`, `New`, `DisplayNote`, `Save`) can be used from `main`. The package is imported as `"notes.practice/note"`.

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
func (note Note) DisplayNote() { ... }

func (note Note) Save() error { ... }
```

Both methods only read the struct, so a value receiver is enough. This matches the rule from the [structs README](../README.md#value-receiver-vs-pointer-receiver): use a pointer receiver only when the method needs to change fields. Passing a `Note` by value copies three small fields, which is cheap.

`main` calls `userNote.DisplayNote()` on a `*Note`. Go follows the pointer and calls the method on a copy, so this works.

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
- A title with characters that are invalid in file names (such as `/`) will make `WriteFile` fail. That error is returned and `main` prints "Saving the note failed!".

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

## Things to watch out for

- **Errors come back as values.** Check `err` after `New` and `Save`, then return or print a message.
- **Struct tags are only metadata.** They do nothing unless a package such as `encoding/json` reads them.
- **Shared input buffers.** Create one `bufio.Reader` per input source, not one per read.
- **File names come from user input.** Titles with spaces, slashes or other special characters can give unexpected file names or errors.

## Next

- Reading and decoding JSON back into a `Note` (`json.Unmarshal`).
- Adding an `ID` or a timestamp-based file name so notes don't overwrite each other.
