package main

import (
	"context"
	"flag"
	"os"
	"os/signal"
	"redis/server"
	"syscall"
)

func main() {
	var verbose bool
	flag.BoolVar(&verbose, "v", false, "print connection and request details")
	flag.BoolVar(&verbose, "verbose", false, "print connection and request details")
	flag.Parse()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	server.StartServer(ctx, "6379", verbose)
}
