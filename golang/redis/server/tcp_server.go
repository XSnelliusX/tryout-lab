package server

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"redis/commands"
	"redis/resp"
	"redis/store"
	"sync"
	"syscall"
)

func StartServer(ctx context.Context, port string, verbose bool) {
	valueStore := store.NewStore()
	commandHandler := commands.NewHandler(valueStore)
	wg := sync.WaitGroup{}

	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		fmt.Println("Error starting server: ", err)
		return
	}

	fmt.Println("Redis server running on port", port)

	stopWatcher := make(chan struct{})
	watcherDone := make(chan struct{})

	go gracefulShutdown(ctx, listener, stopWatcher, watcherDone)
	shuttingDown := false

	// Connection loop accepting connections
	for {
		conn, err := listener.Accept()
		if errors.Is(err, net.ErrClosed) {
			fmt.Println("Listener closed, no new connections accepted")
			shuttingDown = true
			break
		} else if err != nil {
			fmt.Println("Connection error: ", err)
			break
		}

		wg.Go(func() {
			handleConnection(conn, commandHandler, verbose)
		})
	}

	close(stopWatcher)
	<-watcherDone

	err = listener.Close()
	if err != nil && !errors.Is(err, net.ErrClosed) {
		fmt.Println("Error closing listener: ", err)
	}

	wg.Wait()
	if shuttingDown {
		fmt.Println("Server shutdown completed")
	}
}

func gracefulShutdown(ctx context.Context, listener net.Listener, stopWatcher chan struct{}, watcherDone chan struct{}) {
	defer close(watcherDone)

	select {
	case <-ctx.Done():
		fmt.Println("Gracefully shutting down...")

		err := listener.Close()
		if err != nil && !errors.Is(err, net.ErrClosed) {
			fmt.Println("Error closing listener during shutdown:", err)
		}

	case <-stopWatcher:

	}
}

func handleConnection(conn net.Conn, commandHandler *commands.Handler, verbose bool) {
	defer func(conn net.Conn) {
		err := conn.Close()
		if err != nil {
			fmt.Println("Error closing connection: ", err)
		}
	}(conn)
	if verbose {
		fmt.Println("New connection from:", conn.RemoteAddr().String())
	}
	connectionReadLoop(conn, commandHandler, verbose)
}

func connectionReadLoop(conn net.Conn, commandHandler *commands.Handler, verbose bool) {
	// Read needs a byte buffer to write to
	reader := bufio.NewReader(conn)
	for {
		// Handle Request
		decodedCommand, err := resp.DecodeRespRequest(reader)
		if err != nil {
			switch {
			case errors.Is(err, io.EOF):
				if verbose {
					fmt.Println("Client disconnected:", conn.RemoteAddr())
				}
			case errors.Is(err, syscall.ECONNRESET):
				if verbose {
					fmt.Println("Client reset connection:", conn.RemoteAddr())
				}
			default:
				fmt.Println("Error reading request from", conn.RemoteAddr(), ":", err)
			}
			return
		}
		fmt.Println("--------------------------------")
		fmt.Println("New request from", conn.RemoteAddr().String(), ":\n", decodedCommand)
		// encode the handler Result and send it to the connection
		resultObject := commandHandler.HandleCommand(decodedCommand)
		resultBytes, err := resp.Encode(resultObject)
		if err != nil {
			fmt.Println("++++++++++++++++++++++++++++++++++++")
			fmt.Println("Error encoding response:", err)
			fmt.Println("Closing connection:", conn.RemoteAddr().String())
			fmt.Println("++++++++++++++++++++++++++++++++++++")
			return
		}
		_, err = conn.Write(resultBytes)
		if err != nil {
			fmt.Println("++++++++++++++++++++++++++++++++++++")
			fmt.Println("Error writing response:", err)
			fmt.Println("Closing connection:", conn.RemoteAddr().String())
			fmt.Println("++++++++++++++++++++++++++++++++++++")
			return
		}
		fmt.Println("--------------------------------")
		fmt.Println("Server Response for request", decodedCommand, ":\n", string(resultBytes), "Bytes:", resultBytes)
	}
}
