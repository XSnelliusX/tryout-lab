package server

import (
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
	readBuf := make([]byte, 128)
	for {
		nBytes, err := conn.Read(readBuf)
		if err != nil {
			if err == io.EOF {
				fmt.Println("++++++++++++++++++++++++++++++++++++")
				fmt.Println("Client disconnected:", conn.RemoteAddr().String())
				fmt.Println("++++++++++++++++++++++++++++++++++++")
			} else {
				fmt.Println("Error reading received bytes:", err)
			}
			return
		}
		// Handle Request
		fmt.Println("\n--------------------------------")
		fmt.Println("New request from", conn.RemoteAddr().String())
		fmt.Println("\nNumber of bytes: ", nBytes, "\nRead Bytes: ", readBuf[:nBytes])
		fmt.Print("\nRequest string:\n\n", resp.DecodeRespRequest(readBuf[:nBytes]))
		fmt.Println("\n--------------------------------")

		// just return okay for now
		okBytes := []byte("+OK\r\n")
		conn.Write(okBytes)
	}
}
