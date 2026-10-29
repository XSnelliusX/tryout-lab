package commands

type ResultKind int

const (
	ReplySimpleString ResultKind = iota
	ReplyBulkString
	ReplyNoneBulkString
	ReplyError
)

type Result struct {
	Kind  ResultKind
	Value string
}
