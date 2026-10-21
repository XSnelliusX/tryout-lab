package main

import (
	"concurrency/greet"
	"concurrency/report"
	"fmt"
)

func main() {
	fmt.Println("--- Goroutines and channels ---")
	greet.Run()

	fmt.Println("--- Sales reports ---")
	if err := report.Run("sales.txt"); err != nil {
		fmt.Println("Error:", err)
	}

	fmt.Println("--- Sales reports with a negative amount ---")
	if err := report.Run("sales_invalid.txt"); err != nil {
		fmt.Println("Error:", err)
	}
}
