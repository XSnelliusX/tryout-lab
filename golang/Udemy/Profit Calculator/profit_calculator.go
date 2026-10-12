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

	revenue = userInput("How much revenue do you have: ")
	expense = userInput("How much expenses do you have: ")
	taxRate = userInput("How high is your tax rate: ")

	ebt, profit, ratio := calculateOutputs(revenue, expense, taxRate)

	fmt.Println("\n --------------------------")
	fmt.Printf("EBT: %.2f\n", ebt)
	fmt.Printf("Profit: %.2f\n", profit)
	fmt.Printf("Ratio: %.2f\n", ratio)
}

func userInput(infoText string) float64 {
	var userInput float64

	fmt.Print(infoText)
	fmt.Scan(&userInput)

	return userInput
}

func calculateOutputs(revenue, expense, taxRate float64) (float64, float64, float64) {
	ebt := revenue - expense
	profit := ebt * (1 - taxRate/100)
	ratio := profit / ebt * 100

	return ebt, profit, ratio
}
