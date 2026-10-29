package main

import (
	"flag"
	"redis/server"
)

func main() {
	var verbose bool
	flag.BoolVar(&verbose, "v", false, "print connection and request details")
	flag.BoolVar(&verbose, "verbose", false, "print connection and request details")
	flag.Parse()

	server.StartServer("6379", verbose)
}
