package main

import (
	"fmt"
	"functions/anonymous"
	"functions/closures"
	"functions/functionvalues"
	"functions/recursion"
	"functions/variadic"
)

func main() {
	functionvalues.Run()
	fmt.Println("")
	functionvalues.RunReturn()
	fmt.Println("")
	anonymous.Run()
	fmt.Println("")
	closures.Run()
	fmt.Println("")
	recursion.Run()
	fmt.Println("")
	variadic.Run()
	fmt.Println("")
	variadic.RunSpread()
}
