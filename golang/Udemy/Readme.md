# Go - The Complete Guide (Udemy)

Working through *Go - The Complete Guide* Udemy course by Maximilian Schwarzmüller.

Each exercise lives in one file and evolves with the course. Git history is the record of each lecture step; use `git show <commit>:<path>` to view an earlier version.

## Progress

| Lecture | Exercise | What changed | Commit |
| --- | --- | --- | --- |
| 10–26 | [Investment Calculator](Investment%20Calculator/investment_calculator.go) | Built the investment calculator | `9502744` |
| 27 | [Profit Calculator](Profit%20Calculator/profit_calculator.go) | Built the profit calculator (EBT, profit, ratio) | `9502744`, `719cb45` |
| 36 | [Profit Calculator](Profit%20Calculator/profit_calculator.go) | Split logic into reusable functions (`userInput`, `calculateOutputs`) | `f11fa3e` |
| 37–50 | [Bank](Bank/bank.go) | Control structures, loops, error handling and file storage (balance persisted to `balance.txt`) | `aa4e279` |
| 51 | [Profit Calculator](Profit%20Calculator/profit_calculator.go) | Validate input and append results to `profits.txt` (created if missing) | `31da183` |
| 54–60 | [Bank](Bank/bank.go) | Split code into packages: exported functions in `fileops/`, menu helpers in `communication.go` | `25db1d0` |
| 63–71 | [Pointers](pointers/pointers.go) | Pointers: address-of and dereference, passing pointers to functions to change the caller's value (see [pointers README](pointers/README.md)) | `2e972b6` |

