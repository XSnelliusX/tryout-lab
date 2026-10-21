package greet

import (
	"fmt"
	"time"
)

func greet(phrase string, doneChan chan bool) {
	fmt.Println("Hello!", phrase)
	doneChan <- true
}

func slowGreet(phrase string, doneChan chan bool) {
	time.Sleep(3 * time.Second) // simulate a slow, long-taking task
	greet(phrase, doneChan)
}

// Run starts four goroutines that share one channel and waits for all of them.
func Run() {
	done := make(chan bool)

	go greet("Nice to meet you!", done)
	go greet("How are you?", done)
	go slowGreet("How ... are ... you ...?", done)
	go greet("I hope you're liking the course!", done)

	// Each worker sends once. Only close after receiving all four signals;
	// a sleep does not tell us which goroutine will send last.
	completed := 0
	for range done {
		completed++
		if completed == 4 {
			close(done)
		}
	}
}
