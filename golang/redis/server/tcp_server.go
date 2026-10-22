package server

import (
	"fmt"
	"net"
	"redis/resp"
)

func StartServer(port string) {
	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		fmt.Println("Error starting Server: ", err)
		return
	}
	defer listener.Close()
	fmt.Println("Redis server running on Port", port)

	// Connection loop accepting connections
	for {
		conn, err := listener.Accept()
		if err != nil {
			fmt.Println("Connection Error: ", err)
			continue
		}
		handleConnection(conn)
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()
	fmt.Println("Now connection from: ", conn.RemoteAddr().String())
	connectionReadLoop(conn)
}

func connectionReadLoop(conn net.Conn) {
	// Read needs a byte buffer to write to
	readBuf := make([]byte, 128)
	for {
		nBytes, err := conn.Read(readBuf)
		if err != nil {
			fmt.Println("Error Reading recieved bytes: ", err)
			continue
		}
		// Handle Request
		fmt.Println("Number of Bytes: ", nBytes, "\nRead Bytes: ", readBuf[:nBytes])
		fmt.Print("\nRequest String: ", resp.DecodeRespRequest(readBuf[:nBytes]))

		// just return okay for now
		okBytes := []byte("+OK\r\n")
		conn.Write(okBytes)
	}
}
