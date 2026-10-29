package commands

import (
	"errors"
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

func (h *Handler) HandleCommand(command []string) (Result, error) {
	if len(command) == 0 {
		return Result{ReplyError, "empty command"}, errors.New("empty command")
	}

	switch strings.ToLower(command[0]) {
	case "get":
		return h.get(command)
	case "set":
		return h.set(command)
	}
	return Result{ReplyError, "command not supported"}, errors.New("command not supported")
}
