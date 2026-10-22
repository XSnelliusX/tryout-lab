package main

import (
	"redis/server"
)

func main() {
	server.StartServer("6379")
}
