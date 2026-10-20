# Functions (Advanced)

Deeper dive into functions, each topic in its own package with its own README:

| Topic | Idea | Code | README |
| --- | --- | --- | --- |
| Functions as values | pass functions into (and return them from) other functions | [functionvalues/functionvalues.go](functionvalues/functionvalues.go) | [Functions as values](functionvalues/README.md) |
| Anonymous functions | define a function just in time, where it is needed | [anonymous/anonymous.go](anonymous/anonymous.go) | [Anonymous functions](anonymous/README.md) |
| Closures | anonymous functions that lock in outer scope values | [closures/closures.go](closures/closures.go) | [Closures](closures/README.md) |

Run all demos with `go run .` from this folder — [main.go](main.go) calls each demo in turn and prints a labeled section per topic.
