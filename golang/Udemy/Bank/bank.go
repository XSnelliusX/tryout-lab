package main

import (
	"bank/fileops"
	"fmt"
)

const accountBalanceFile = "balance.txt"

func main() {
	var accountBalance, err = fileops.GetFloatFromFile(accountBalanceFile, 0)

	if err != nil {
		fmt.Print("-------------------")
		fmt.Print("ERROR")
		fmt.Print(err)
		fmt.Print("-------------------")
	}

	fmt.Println("Welcome to Go Bank!")

	for {
		presentOptions()

		var choice int
		fmt.Print("Your choice: ")
		fmt.Scan(&choice)

		switch choice {
		case 1:
			fmt.Println("Your balance is ", accountBalance)
		case 2:
			fmt.Print("How much do you want to doposit: ")
			var depositAmount float64
			fmt.Scan(&depositAmount)

			if depositAmount <= 0 {
				fmt.Println("Deposit amount can not be negative!")
				continue
			}

			accountBalance += depositAmount
			fmt.Println("Your new Balance is: ", accountBalance)
			fileops.WriteFloatToFile(accountBalanceFile, accountBalance)
		case 3:
			fmt.Print("How much do you want to withdraw: ")
			var withdrawlAmount float64
			fmt.Scan(&withdrawlAmount)

			if withdrawlAmount <= 0 {
				fmt.Println("Withdrawl amount can not be negative!")
				continue
			} else if withdrawlAmount > accountBalance {
				fmt.Println("You cant withdraw more then your balance!")
				continue
			}

			accountBalance -= withdrawlAmount
			fmt.Println("Your new Balance is: ", accountBalance)
			fileops.WriteFloatToFile(accountBalanceFile, accountBalance)
		default:
			fmt.Println("Goodbye!")
			fmt.Println("")
			return
		}
	}
}
