package commands

import (
	"fmt"
	"redis/store"
	"strings"
)

type Handler struct {
	valueStore *store.Store
}

func NewHandler(valueStore *store.Store) *Handler {
	return &Handler{
		valueStore: valueStore,
	}
}

func (h *Handler) HandleCommand(command []string) Result {
	if len(command) == 0 {
		return Result{ReplyError, "invalid argument(s)"}
	}

	switch strings.ToLower(command[0]) {
	case "get":
		return h.get(command)
	case "set":
		return h.set(command)
	}
	unknownCommandReply := fmt.Sprintf("unknown command %s", command[0])
	return Result{ReplyError, unknownCommandReply}
}
