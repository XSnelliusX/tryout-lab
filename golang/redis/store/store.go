package store

import "sync"

type Store struct {
	mu       sync.RWMutex
	valueMap map[string]string
}

func (s *Store) Set(key string, value string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.valueMap[key] = value
}

func (s *Store) Get(key string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	val, exists := s.valueMap[key]
	return val, exists
}

func NewStore() *Store {
	return &Store{
		valueMap: make(map[string]string),
	}
}
