package store

import "testing"

func TestSetAndGet(t *testing.T) {
	s := NewStore()

	s.Set("key", "value")
	got, exists := s.Get("key")

	if !exists {
		t.Error("key doesn't exist")
	}
	if got != "value" {
		t.Errorf("got %v, expected value", got)
	}
}
