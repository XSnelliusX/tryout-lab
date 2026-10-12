package main

import "fmt"

/*
	Goal: Calcualte earnings before tax (EBT), profit and ratio
	Input: revenue, expenses & tax rate
*/

func main() {
	var revenue, expense, taxRate float64

	fmt.Println("Welcome to the Earnings calcualtor")
	fmt.Println("I calcualte earnings before tax (EBT), earnings after tax, profit and ratio")

	fmt.Print("How much revenue do you have: ")
	fmt.Scan(&revenue)
	fmt.Print("How much expenses do you have: ")
	fmt.Scan(&expense)
	fmt.Print("How high is your tax rate: ")
	fmt.Scan(&taxRate)

	ebt := revenue - expense
	profit := ebt * (1 - taxRate/100)
	ratio := profit / ebt * 100

	fmt.Println("\n --------------------------")
	fmt.Printf("EBT: %.2f\n", ebt)
	fmt.Printf("Profit: %.2f\n", profit)
	fmt.Printf("Ratio: %.2f\n", ratio)
}
