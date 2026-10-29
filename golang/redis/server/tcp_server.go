package server

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"redis/commands"
	"redis/resp"
	"redis/store"
)

func StartServer(port string) {
	valueStore := store.NewStore()
	commandHandler := commands.NewHandler(valueStore)

	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		fmt.Println("Error starting server: ", err)
		return
	}
	defer listener.Close()
	fmt.Println("Redis server running on port", port)

	// Connection loop accepting connections
	for {
		conn, err := listener.Accept()
		if err != nil {
			fmt.Println("Connection error: ", err)
			return
		}
		go handleConnection(conn, commandHandler)
	}
}

func handleConnection(conn net.Conn, commandHandler *commands.Handler) {
	defer conn.Close()
	fmt.Println("++++++++++++++++++++++++++++++++++++")
	fmt.Println("New connection from:", conn.RemoteAddr().String())
	fmt.Println("++++++++++++++++++++++++++++++++++++")

	connectionReadLoop(conn, commandHandler)
}

func connectionReadLoop(conn net.Conn, commandHandler *commands.Handler) {
	// Read needs a byte buffer to write to
	reader := bufio.NewReader(conn)
	for {
		// Handle Request
		decodedCommand, err := resp.DecodeRespRequest(reader)
		if err != nil {
			if err == io.EOF {
				fmt.Println("++++++++++++++++++++++++++++++++++++")
				fmt.Println("Client disconnected:", conn.RemoteAddr().String())
				fmt.Println("++++++++++++++++++++++++++++++++++++")
			} else {
				fmt.Println("Error decoding request:", err)
				fmt.Println("++++++++++++++++++++++++++++++++++++")
				fmt.Println("Closing connection: ", conn.RemoteAddr().String())
				fmt.Println("++++++++++++++++++++++++++++++++++++")
			}
			return
		}
		fmt.Println("\n--------------------------------")
		fmt.Println("New request from", conn.RemoteAddr().String())
		fmt.Print("\nHandling Request:\n\n", decodedCommand)
		// TODO: encode the handler Result and send it to the connection
		_ = commandHandler.HandleCommand(decodedCommand)
		if err != nil {
			return
		}

		fmt.Println("\n--------------------------------")

		// just return okay for now
		okBytes := []byte("+OK\r\n")
		conn.Write(okBytes)
	}
}
