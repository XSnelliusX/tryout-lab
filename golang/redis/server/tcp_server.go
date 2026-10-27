package server

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"redis/resp"
)

func StartServer(port string) {
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
		go handleConnection(conn)
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()
	fmt.Println("++++++++++++++++++++++++++++++++++++")
	fmt.Println("New connection from:", conn.RemoteAddr().String())
	fmt.Println("++++++++++++++++++++++++++++++++++++")

	connectionReadLoop(conn)
}

func connectionReadLoop(conn net.Conn) {
	// Read needs a byte buffer to write to
	reader := bufio.NewReader(conn)
	for {
		// Handle Request
		decodedString, err := resp.DecodeRespRequest(reader)
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
		fmt.Print("\nRequest string:\n\n", decodedString)
		fmt.Println("\n--------------------------------")

		// just return okay for now
		okBytes := []byte("+OK\r\n")
		conn.Write(okBytes)
	}
}
