package main

import (
	"fmt"
	"functions/anonymous"
	"functions/closures"
	"functions/functionvalues"
)

func main() {
	functionvalues.Run()
	fmt.Println("")
	functionvalues.RunReturn()
	fmt.Println("")
	anonymous.Run()
	fmt.Println("")
	closures.Run()
}
