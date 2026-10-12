# Go

Notes and exercises from my Go learning track: language basics, tooling, and two sources I'm working through.

## About the language

Go is a compiled, statically typed language designed at Google for building simple, reliable, and efficient software.

- **Compiled:** `go build` produces a single static machine-code binary — no VM or interpreter runtime required. Cross-compilation is built in via `GOOS`/`GOARCH`. `go run` compiles and executes in one step, which is handy for exercises.
- **Statically typed:** types are checked at compile time; `:=` infers types from values so declarations stay short.
- **Garbage collected:** memory is managed automatically, no manual malloc/free.
- **Concurrency as a language feature:** goroutines and channels are built into the language and runtime, not bolted on as a library.
- **Batteries included:** a large standard library (`net/http`, `encoding/json`, `testing`, ...) and a single toolchain for everything: `go fmt`, `go vet`, `go test`, `go mod`.
- **Modules:** dependencies and the required Go version are declared per project in `go.mod`.

## Toolchain and version management

Go is installed and version-managed with [asdf](https://asdf-vm.com) (plugin: `golang`). Global default, per-project pins, and everyday commands are documented in [asdf.md](asdf.md).

Project setup used here: each exercise folder is its own module (`go mod init <name>`). The book chapters additionally use a [Makefile](Learning%20Go/ch1/Makefile) chaining `go fmt` → `go vet` → `go build`.

## Learning material

| Track | Material | Folder |
| --- | --- | --- |
| Book | [*Learning Go*, 2nd Edition](https://www.oreilly.com/library/view/learning-go-2nd/9781098101393/) by Jon Bodner (O'Reilly) | [Learning Go/](Learning%20Go/) |
| Course | [*Go - The Complete Guide*](https://www.udemy.com/course/go-the-complete-guide/) by Maximilian Schwarzmüller (Udemy) | [Udemy/](Udemy/) |
